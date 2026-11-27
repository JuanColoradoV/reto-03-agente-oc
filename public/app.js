// Frontend sin build. El estado de la conversacion vive en el servidor (Durable Object por sesion):
// aqui solo se guarda el sessionId (sessionStorage). Todo el texto se inserta con textContent (nunca innerHTML).
(() => {
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), sendBtn = $("send"), loading = $("loading"), banner = $("banner"), resetBtn = $("reset"), scroller = $("scroller");

  const newId = () => crypto.randomUUID();
  let sessionId;
  try { sessionId = sessionStorage.getItem("sid"); } catch { /* sin storage */ }
  if (!sessionId) { sessionId = newId(); try { sessionStorage.setItem("sid", sessionId); } catch { /* ignorado */ } }

  let pendingId = null; // accion pendiente activa (segun el servidor)
  let busy = false;
  let gen = 0; // generacion: ignora respuestas de peticiones viejas tras "Nueva conversacion"
  let ctrl = null; // AbortController de la peticion en curso
  let mock = false;
  let solicitudes = [];
  let restoring = true; // restaurando la sesion desde el servidor
  let restoreFailed = false; // la restauracion fallo/expiro: el chat no esta listo hasta empezar de nuevo
  let replaying = false; // durante restore() no se pide la traza por cada evento "usage"
  let traceSeq = 0;
  const RESTORE_TIMEOUT_MS = 6000;
  const toolCards = new Map(); // toolUseId -> { d, pill, ms, body, name }
  const confirmCards = new Map();
  const toolSol = new Map(); // toolUseId -> solicitudId
  const solStatus = new Map(); // solicitudId -> "creada" | "bloqueada"
  const solOc = new Map(); // solicitudId -> numero de OC (ya creada en esta sesion)
  const solSupplier = new Map(); // solicitudId -> "Nombre (P-0001)" (de la tarjeta de aprobacion)
  const SHORT = matchMedia("(max-width: 760px)");
  const LOW = matchMedia("(max-height: 500px)"); // 400% de zoom: la pagina entera se desplaza

  // Vocabulario unico de resultados (paso a paso, lista lateral, tarjetas y texto del agente).
  const OUTCOME = { creada: "OC creada", bloqueada: "Bloqueada por controles", rechazada: "Rechazada por el aprobador", pendiente: "Pendiente de aprobación" };
  // Estado del turno en curso: la tarjeta de resultado se pinta al FINAL del turno, despues del texto del agente.
  const newTurn = () => ({ outcome: null, processing: false, motivo: "" });
  let turn = newTurn();

  // ---------- utilidades de DOM (solo textContent) ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const json = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const fmtNum = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    const [int, dec] = Math.abs(x).toFixed(Number.isInteger(x) ? 0 : 2).split(".");
    return (x < 0 ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (dec ? "," + dec : "");
  };
  const fmtMoney = (n, cur) => `${fmtNum(n)} ${cur || "COP"}`;
  // Hora del evento: usa `ts` del servidor (sirve tambien al restaurar); si falta, en vivo usa la hora local y al restaurar no muestra hora.
  const clock = (ts) => {
    if (!ts && replaying) return "";
    const d = ts ? new Date(ts) : new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(".", ",") + "k" : String(n));
  const scroll = () => {
    if (pendingId) return;
    scroller.scrollTop = scroller.scrollHeight;
    if (LOW.matches) window.scrollTo(0, document.documentElement.scrollHeight);
  };
  // Avisos cortos para lectores de pantalla (el registro del chat no es una region en vivo).
  const srStatus = $("sr-status");
  const announce = (msg) => { if (replaying || !msg) return; srStatus.textContent = ""; setTimeout(() => { srStatus.textContent = msg; }, 60); };
  const showBanner = (msg) => { banner.textContent = msg || ""; banner.hidden = !msg; };
  const hint = $("composer-hint");
  const showHint = (msg) => { hint.textContent = msg || ""; hint.hidden = !msg; };

  function pill(kind, icon, label) {
    const p = el("span", "pill " + kind);
    if (icon === "spin") { /* estado en curso: la elipsis animada la dibuja el CSS */ p.classList.add("running"); }
    else if (icon) { const i = el("span", "ic", icon); i.setAttribute("aria-hidden", "true"); p.append(i); }
    p.append(document.createTextNode(label));
    return p;
  }

  // Texto del agente: parrafos, listas "- " y **negrita**/`codigo`, todo construido con nodos de texto.
  function inline(text) {
    const frag = document.createDocumentFragment();
    const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(m[1] !== undefined ? el("strong", "", m[1]) : el("code", "", m[2]));
      last = re.lastIndex;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }
  function prose(text) {
    const box = el("div", "prose");
    for (const block of String(text).trim().split(/\n{2,}/)) {
      let ul = null, p = null;
      for (const line of block.split("\n")) {
        const b = line.match(/^\s*[-*•]\s+(.*)$/);
        if (b) {
          p = null;
          if (!ul) { ul = el("ul"); box.append(ul); }
          const li = el("li"); li.append(inline(b[1])); ul.append(li);
        } else {
          ul = null;
          if (!p) { p = el("p"); box.append(p); } else p.append(document.createElement("br"));
          p.append(inline(line));
        }
      }
    }
    return box;
  }


  // ---------- lenguaje llano para herramientas ----------
  const TOOL_LABEL = {
    leer_solicitud: "Leyendo los documentos de la solicitud (correo, cotización, aprobación)",
    validar_controles: "Revisando los controles de compra",
    crear_orden_compra: "Preparando la orden de compra",
    listar_solicitudes: "Buscando solicitudes pendientes",
    listar_ordenes: "Buscando las órdenes creadas",
    consultar_orden: "Consultando la orden en SAP",
  };
  const toolLabel = (name) => TOOL_LABEL[name] || name;
  const failures = (controles) => (Array.isArray(controles) ? controles.filter((c) => c.resultado === "FALLA") : []);
  const firstFailText = (controles) => { const f = failures(controles)[0]; return f ? `${f.nombre}: ${f.detalle}` : ""; };
  const isBlockedErr = (o) => typeof o === "string" && o.startsWith("No se puede crear");
  const isRejected = (o) => typeof o === "string" && o.startsWith("RECHAZADA");
  // Estado de la fila: la EJECUCION de la herramienta es una cosa y el RESULTADO de negocio otra. Para validar_controles
  // el estado sale de los controles (nunca un OK verde junto a una falla).
  function toolPill(e) {
    const o = e.output;
    if (!e.ok) {
      if (isRejected(o)) return ["", "✕", OUTCOME.rechazada];
      if (isBlockedErr(o)) return ["falla", "✕", OUTCOME.bloqueada];
      return ["error", "✕", "Error"];
    }
    if (e.name === "validar_controles" && o && Array.isArray(o.controles)) {
      const cnt = (r) => o.controles.filter((x) => x.resultado === r).length;
      const f = cnt("FALLA"), a = cnt("ALERTA");
      const bits = [`${cnt("OK")} OK`];
      if (a) bits.push(`${a} ${a === 1 ? "alerta" : "alertas"}`);
      if (f) bits.push(`${f} ${f === 1 ? "falla" : "fallas"}`);
      return f ? ["falla", "✕", bits.join(" · ")] : a ? ["alerta", "▲", bits.join(" · ")] : ["ok", "✓", bits.join(" · ")];
    }
    if (e.name === "crear_orden_compra") return ["ok", "✓", OUTCOME.creada];
    return ["ok", "✓", "Listo"];
  }
  // Resumen corto de una linea (el motivo completo vive en la tarjeta de resultado, no se repite aqui).
  function toolSummary(e) {
    const o = e.output;
    if (!e.ok) {
      if (isRejected(o) || isBlockedErr(o)) return "No se creó la orden";
      const t = typeof o === "string" ? o : "";
      return "No se pudo completar" + (t ? ": " + t.slice(0, 90) : "");
    }
    switch (e.name) {
      case "leer_solicitud": {
        if (!o || typeof o !== "object") return "Documentos leídos";
        const n = 3 + (o.aprobacion ? 1 : 0) + (o.factura ? 1 : 0);
        return `${n} documentos leídos`;
      }
      case "validar_controles": return o && Array.isArray(o.controles) ? `${o.controles.length} controles revisados` : "Controles revisados";
      case "crear_orden_compra": return o && o.numero ? `Número ${o.numero}` : "Orden creada";
      case "listar_solicitudes": { const l = Array.isArray(o) ? o : o && o.solicitudes; return Array.isArray(l) ? `${l.length} solicitudes encontradas` : "Solicitudes encontradas"; }
      case "listar_ordenes": { const l = Array.isArray(o) ? o : o && o.ordenes; return Array.isArray(l) ? `${l.length} órdenes` : "Órdenes encontradas"; }
      case "consultar_orden": return "Orden consultada";
      default: return "";
    }
  }

  // ---------- progreso de la solicitud (derivado de los eventos) ----------
  const STEPS = ["Leer documentos", "Validar controles", "Tu aprobación", "Crear OC en SAP"];
  let flow = null; // { sol, st: ["todo"|"run"|"done"|"blocked" x4], outcome, blockedAt }
  const stepper = $("stepper");
  function flowStart(sol) { flow = { sol, st: ["run", "todo", "todo", "todo"], outcome: "", blockedAt: -1 }; renderStepper(); }
  function flowSet(i, state, outcome) {
    if (!flow) flowStart("");
    if (flow.blockedAt >= 0 && state !== "blocked") return; // tras un bloqueo el progreso no avanza
    flow.st[i] = state;
    if (state === "blocked") { flow.outcome = outcome || OUTCOME.bloqueada; flow.blockedAt = i; }
    else if (i === 3 && state === "done") flow.outcome = OUTCOME.creada;
    renderStepper();
  }
  function flowPending() { if (flow && flow.blockedAt < 0) { flow.outcome = OUTCOME.pendiente; renderStepper(); } }
  function renderStepper() {
    stepper.replaceChildren();
    stepper.hidden = !flow;
    if (!flow) return;
    stepper.setAttribute("role", "group");
    stepper.setAttribute("aria-label", "Progreso de la solicitud" + (flow.sol ? " " + flow.sol : ""));
    let cur = flow.blockedAt >= 0 ? flow.blockedAt : flow.st.indexOf("run");
    if (cur < 0) cur = Math.max(0, flow.st.lastIndexOf("done"));
    const rejected = flow.outcome === OUTCOME.rechazada;
    const top = el("p", "stepper-title", `${flow.sol ? `Solicitud ${flow.sol} · ` : ""}Paso ${cur + 1} de ${STEPS.length}: ${STEPS[cur]}`);
    const ol = el("ol", "stepper-list");
    flow.st.forEach((st, i) => {
      const li = el("li", "step " + st + (st === "blocked" && rejected ? " rejected" : ""));
      const dot = el("span", "dot", st === "done" ? "✓" : st === "blocked" ? "✕" : st === "run" ? "" : String(i + 1));
      dot.setAttribute("aria-hidden", "true");
      const label = el("span", "slabel", STEPS[i]);
      const sr = el("span", "sr-only", ": " + ({ todo: "pendiente", run: "en curso", done: "hecho", blocked: rejected ? "rechazado" : "bloqueado" })[st]);
      li.append(dot, label, sr);
      if (st === "run") li.setAttribute("aria-current", "step");
      ol.append(li);
    });
    stepper.append(top, ol);
    if (flow.blockedAt >= 0) stepper.append(el("p", "stepper-stop" + (rejected ? " rejected" : ""), `${flow.outcome} · Detenido en: ${STEPS[flow.blockedAt]}`));
    else if (flow.outcome) stepper.append(el("p", "stepper-now" + (flow.outcome === OUTCOME.creada ? " ok" : ""), flow.outcome));
  }
  function updateFlowCall(e) {
    const sid = e.input && (e.input.solicitudId || e.input.id);
    const sol = typeof sid === "string" ? sid : "";
    if (e.name === "leer_solicitud") flowStart(sol);
    else if (e.name === "validar_controles") { if (turn.processing && flow && flow.sol === sol) { flowSet(0, "done"); flowSet(1, "run"); } } // una consulta suelta de controles no abre el paso a paso
    else if (e.name === "crear_orden_compra") { if (!flow || (sol && flow.sol !== sol)) flowStart(sol); flowSet(0, "done"); flowSet(1, "done"); flowSet(2, "run"); }
  }
  function updateFlowResult(e, sid) {
    const mine = flow && (!sid || !flow.sol || flow.sol === sid);
    if (!mine || (e.name === "validar_controles" && !turn.processing)) return; // una consulta suelta no toca el paso a paso
    if (e.name === "leer_solicitud") flowSet(0, e.ok ? "done" : "blocked", "No se pudieron leer los documentos");
    else if (e.name === "validar_controles" && e.ok && e.output) {
      if (e.output.aprobable === false) flowSet(1, "blocked", OUTCOME.bloqueada);
      else flowSet(1, "done");
    } else if (e.name === "crear_orden_compra") {
      if (e.ok) { flowSet(2, "done"); flowSet(3, "done"); }
      else if (isRejected(e.output)) { if (flow.st[2] !== "blocked") flowSet(2, "blocked", OUTCOME.rechazada); }
      else if (isBlockedErr(e.output)) flowSet(1, "blocked", OUTCOME.bloqueada);
      else if (flow.st[3] === "run") flowSet(3, "blocked", "Error al crear la orden en SAP");
    }
  }

  // ---------- estado de controles de la UI ----------
  function refreshControls() {
    const lock = busy || !!pendingId;
    loading.hidden = !(busy || restoring);
    $("loading-text").textContent = busy ? "El agente está trabajando…" : "Preparando el agente y cargando la conversación…";
    sendBtn.disabled = lock;
    input.disabled = lock;
    input.placeholder = pendingId ? (SHORT.matches ? "Resuelve la aprobación…" : "Resuelve la aprobación pendiente para continuar…") : SHORT.matches ? "Escribe o elige una solicitud…" : `Ej.: ${examples()}`;
    // Una solicitud con OC creada no se puede procesar de nuevo (el servidor tambien lo bloquea: control C0).
    document.querySelectorAll("[data-quick]").forEach((c) => (c.disabled = lock || c.dataset.done === "1"));
    // Los botones de la tarjeta de aprobacion se habilitan solo cuando el servidor termino el turno (estado ya guardado y
    // sesion libre); si no, un clic temprano chocaria con 409 sesion_ocupada.
    confirmCards.forEach((c, id) => {
      if (id !== pendingId) return;
      const off = busy || restoring;
      c.ok.disabled = c.no.disabled = c.ta.disabled = off;
    });
    resetBtn.disabled = false; // "Nueva conversacion" aborta la peticion en curso
  }
  function setBusy(b) { busy = b; refreshControls(); }

  // ---------- estado vacio, solicitudes y traza ----------
  // Ejemplos de texto derivados de las solicitudes que devuelve la API (nada de IDs fijos en el código).
  function examples() {
    const [a, b] = solicitudes.map((x) => x.id);
    return a ? `"Procesa la solicitud ${a}"` + (b ? ` o "¿Qué controles fallaron en ${b}?"` : "") : '"Procesa una solicitud"';
  }
  const quickMessage = (id) => `Procesa la solicitud ${id}: léela, valida los controles y, si corresponde, pídeme confirmación para crear la orden de compra.`;

  function renderEmpty() {
    const box = el("section", "empty");
    box.id = "empty";
    box.append(
      el("h2", "", "Procesa una solicitud de compra"),
      el("p", "lead", "El agente lee los documentos de una solicitud, revisa los controles de compra y, solo si tú apruebas, crea la orden en SAP (simulado). Elige una solicitud o escríbele."),
    );
    const steps = el("ol", "steps");
    [["Lee la solicitud.", "El correo, la cotización y la aprobación."], ["Valida los controles.", "Te muestra cada resultado, uno por uno."], ["Pide tu aprobación y crea la OC.", "Sin tu decisión no se crea nada en SAP."]].forEach(([h, t]) => { const li = el("li"); li.append(el("strong", "", h), document.createTextNode(" " + t)); steps.append(li); });
    const acts = el("div", "actions");
    acts.setAttribute("role", "group");
    acts.setAttribute("aria-label", "Probar un caso");
    if (solicitudes.length) acts.append(el("span", "actions-label", "Probar un caso:"));
    for (const s of solicitudes) {
      const oc = solOc.get(s.id);
      const b = el("button", "btn btn-quiet", oc ? `${s.id} · ya tiene OC ${oc}` : `Probar ${s.id}`);
      b.type = "button"; b.dataset.quick = "1"; b.title = oc ? `La solicitud ya tiene la OC ${oc}: no se puede procesar de nuevo.` : s.asunto || "";
      if (oc) b.dataset.done = "1";
      b.onclick = () => send(quickMessage(s.id));
      acts.append(b);
    }
    box.append(steps, acts, el("p", "examples", solicitudes.length ? `También puedes escribir: ${examples()}` : "También puedes escribir tu petición en el cuadro de abajo."));
    return box;
  }

  const STATUS = {
    sin: ["", "○", "Sin procesar"],
    aprobacion: ["alerta", "…", OUTCOME.pendiente],
    creada: ["ok", "✓", OUTCOME.creada],
    bloqueada: ["falla", "✕", OUTCOME.bloqueada],
    rechazada: ["", "✕", OUTCOME.rechazada],
  };
  function renderQuick() {
    const ul = $("quick");
    ul.replaceChildren();
    if (!solicitudes.length) { ul.append(el("li", "muted small", "Sin solicitudes disponibles.")); return; }
    for (const s of solicitudes) {
      const li = el("li");
      const b = el("button", "req"); b.type = "button"; b.dataset.quick = "1";
      const [kind, icon, label] = STATUS[solStatus.get(s.id) || "sin"];
      const top = el("span", "req-top");
      top.append(el("span", "req-id", s.id), pill(kind, icon, label));
      b.append(top, el("span", "req-sub", s.asunto || "(sin asunto)"));
      if (s.solicitante) b.append(el("span", "req-who", s.solicitante));
      const oc = solOc.get(s.id);
      if (oc) {
        b.dataset.done = "1"; // deshabilitado con motivo (visible y en title)
        b.title = `Ya tiene la OC ${oc}: no se puede procesar de nuevo.`;
        b.append(el("span", "req-who", `Ya tiene OC ${oc}`));
      }
      b.onclick = () => { closeDrawer(); send(quickMessage(s.id)); };
      li.append(b); ul.append(li);
    }
    refreshControls();
  }
  function setSolStatus(id, st, oc) {
    if (!id) return;
    if (solStatus.get(id) === "creada" && st !== "creada") return; // una OC ya creada no se degrada (p. ej. al reprocesar el duplicado)
    solStatus.set(id, st);
    if (st === "creada" && oc) solOc.set(id, oc);
    renderQuick();
    // El estado vacio (si aun se ve) tambien refleja que la solicitud ya tiene OC.
    if ($("empty")) $("empty").replaceWith(renderEmpty());
    refreshControls();
  }

  async function loadTrace() {
    const box = $("trace");
    const mySeq = ++traceSeq, myGen = gen;
    try {
      const res = await fetch(`/api/sesion/${sessionId}/traza`, { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) });
      if (!res.ok) throw new Error(String(res.status));
      const { trace } = await res.json();
      if (mySeq !== traceSeq || myGen !== gen) return; // respuesta vieja
      box.replaceChildren();
      if (!trace.length) { box.append(el("p", "muted small", "Aún sin actividad.")); return; }
      const sum = trace.reduce((a, t) => ({ calls: a.calls + t.usage.calls, inp: a.inp + t.usage.input, out: a.out + t.usage.output, cr: a.cr + t.usage.cacheRead, cost: a.cost + t.usage.costUsd }), { calls: 0, inp: 0, out: 0, cr: 0, cost: 0 });
      const stats = el("dl", "stats");
      const stat = (v, l) => { const r = el("div", "stat"); r.append(el("dt", "", l), el("dd", "", v)); stats.append(r); };
      stat(trace.length, "Turnos"); stat(sum.calls, "Llamadas al modelo"); stat(`${k(sum.inp)} / ${k(sum.out)}`, "Tokens ent. / sal."); stat(`US$ ${sum.cost.toFixed(4)}`, mock ? "Costo estimado (simulado)" : "Costo estimado");
      box.append(stats);
      const agg = new Map();
      for (const t of trace) for (const x of t.tools) { const a = agg.get(x.name) || { n: 0, ms: 0, err: 0, blk: 0 }; a.n++; a.ms += x.ms; if (x.bloqueo) a.blk++; else if (!x.ok) a.err++; agg.set(x.name, a); }
      if (agg.size) {
        const tbl = el("table", "lat");
        const head = el("tr"); ["Herramienta", "Llam.", "Prom. ms"].forEach((h, i) => { const th = el("th", i ? "num" : "", h); th.scope = "col"; head.append(th); });
        const thead = el("thead"); thead.append(head); tbl.append(thead);
        const tb = el("tbody");
        for (const [name, a] of agg) {
          const r = el("tr");
          const extra = [a.blk ? `${a.blk} bloqueada${a.blk > 1 ? "s" : ""}` : "", a.err ? `${a.err} con error` : ""].filter(Boolean).join(", ");
          r.append(el("td", "", name), el("td", "num", extra ? `${a.n} (${extra})` : a.n), el("td", "num", Math.round(a.ms / a.n)));
          tb.append(r);
        }
        tbl.append(tb); box.append(tbl);
      }
      box.append(el("p", "muted small", `Caché leída ${k(sum.cr)} tokens.`));
      const det = el("details", "turns");
      det.append(el("summary", "", "Detalle por turno"));
      const ol = el("ol", "turn-list");
      trace.forEach((t) => { const u = t.usage; ol.append(el("li", "", `${u.calls} llamada(s) · ${k(u.input)} entrada · ${k(u.output)} salida · caché ${k(u.cacheRead)} leída / ${k(u.cacheWrite)} escrita · ≈ US$ ${u.costUsd.toFixed(4)}`)); });
      det.append(ol); box.append(det);
    } catch {
      if (mySeq === traceSeq && myGen === gen && !box.querySelector(".stats")) box.replaceChildren(el("p", "muted small", "No se pudo cargar la traza."));
    }
  }

  function clearLog() {
    flow = null; renderStepper(); toolCards.clear(); confirmCards.clear(); toolSol.clear(); solStatus.clear(); solOc.clear(); solSupplier.clear(); turn = newTurn();
    log.replaceChildren(renderEmpty());
    renderQuick();
  }
  const dropEmpty = () => $("empty")?.remove();

  // ---------- render de eventos ----------
  function addMsg(role, text) {
    dropEmpty();
    if (role === "user") { log.append(el("div", "msg user", text)); scroll(); return; }
    const m = el("div", "msg assistant");
    m.append(el("p", "who", "Agente"));
    const body = prose(text);
    m.append(body);
    log.append(m); scroll();
  }

  function ctrlPill(c) {
    const r = String(c.resultado).toUpperCase();
    const map = { OK: ["ok", "✓"], ALERTA: ["alerta", "▲"], FALLA: ["falla", "✕"] };
    const [kind, icon] = map[r] || ["", "•"];
    return pill(kind, icon, r);
  }
  function controlsTable(list) {
    const wrap = el("div", "tablewrap");
    const t = el("table", "controles");
    const hr = el("tr");
    ["Código", "Control", "Resultado", "Detalle"].forEach((h) => { const th = el("th", "", h); th.scope = "col"; hr.append(th); });
    const th = el("thead"); th.append(hr); t.append(th);
    const tb = el("tbody");
    for (const c of list) {
      const r = el("tr");
      const a = el("td", "res"); a.append(ctrlPill(c));
      const cn = el("td", "cn", c.nombre);
      if (c.descripcion) cn.append(el("span", "cdesc", c.descripcion));
      r.append(el("td", "cid", c.id), cn, a, el("td", "det", c.detalle));
      tb.append(r);
    }
    t.append(tb); wrap.append(t);
    return wrap;
  }

  const ANNOUNCE_CALL = { leer_solicitud: "Leyendo los documentos…", validar_controles: "Validando controles…", crear_orden_compra: "Preparando la orden de compra…" };

  function addToolCall(e) {
    dropEmpty();
    const d = el("details", "tool");
    const s = el("summary");
    const status = pill("run", "spin", "en curso");
    const ms = el("span", "ms");
    const tm = el("time", "tm", clock(e.ts));
    const main = el("span", "tmain");
    const label = el("span", "tlabel", toolLabel(e.name));
    const sum = el("span", "tsum");
    main.append(label, sum, el("code", "name", e.name));
    s.append(main, status, ms, tm, el("span", "more", "Ver detalle técnico"));
    const body = el("div", "body");
    body.append(el("p", "subh", "Entrada"), el("pre", "", json(e.input)));
    d.append(s, body);
    log.append(d);
    toolCards.set(e.id, { d, status, ms, body, name: e.name, label, sum });
    if (e.name === "leer_solicitud" || e.name === "crear_orden_compra") turn.processing = true;
    updateFlowCall(e);
    const sid = e.input && (e.input.solicitudId || e.input.id);
    if (typeof sid === "string") toolSol.set(e.id, sid);
    announce(ANNOUNCE_CALL[e.name]);
    scroll();
  }
  function swapStatus(c, kind, icon, label) { const p = pill(kind, icon, label); c.status.replaceWith(p); c.status = p; }

  function addToolResult(e) {
    const c = toolCards.get(e.id);
    const sid = toolSol.get(e.id);
    const rechazada = isRejected(e.output);
    if (c) {
      const [kind, icon, label] = toolPill(e);
      swapStatus(c, kind, icon, label);
      if (e.ms) c.ms.textContent = `${fmtNum(e.ms)} ms`;
      c.sum.textContent = toolSummary(e);
      if (e.name === "crear_orden_compra") c.label.textContent = e.ok ? "Orden de compra creada en SAP" : rechazada ? "Creación de la orden rechazada" : "Orden de compra no creada";
      c.body.append(el("p", "subh", e.ok ? "Resultado" : "Error"), el("pre", "", json(e.output)));
    }
    updateFlowResult(e, sid);
    // Los resultados de negocio se anotan en el turno; la tarjeta se pinta AL FINAL del turno (flushOutcome), despues del texto del agente.
    if (e.name === "validar_controles" && e.ok && e.output && e.output.aprobable === false) {
      if (!turn.outcome) turn.outcome = { kind: "bloqueada", controles: e.output.controles };
      setSolStatus(sid, "bloqueada");
    }
    if (e.name === "crear_orden_compra") {
      if (e.ok) { turn.outcome = { kind: "creada", oc: e.output }; setSolStatus(sid || (e.output && e.output.solicitudId), "creada", e.output && e.output.numero); }
      else if (rechazada) { turn.outcome = { kind: "rechazada", motivo: turn.motivo, sol: sid }; setSolStatus(sid, "rechazada"); }
      // "Bloqueada" SOLO por controles en FALLA; un error transitorio (red, SAP, integridad) no pinta la solicitud.
      else if (isBlockedErr(e.output)) { if (!turn.outcome) turn.outcome = { kind: "bloqueada", text: e.output }; setSolStatus(sid, "bloqueada"); }
    }
    scroll();
  }

  function flushOutcome() {
    const o = turn.outcome;
    turn.outcome = null;
    if (!o || !turn.processing) return;
    if (o.kind === "creada") addReceipt(o.oc);
    else if (o.kind === "bloqueada") addBlocked(o.controles, o.text);
    else if (o.kind === "rechazada") addRejected(o.motivo);
    announce(o.kind === "creada" ? OUTCOME.creada : o.kind === "bloqueada" ? OUTCOME.bloqueada : OUTCOME.rechazada);
  }

  function addReceipt(oc) {
    if (!oc || typeof oc !== "object") return;
    const r = el("section", "receipt");
    r.setAttribute("aria-label", OUTCOME.creada);
    const h = el("h2", "rt"); h.append(pill("ok", "✓", OUTCOME.creada), document.createTextNode(` ${oc.numero ?? "—"}`));
    r.append(h);
    const dl = el("dl", "ledger");
    const row = (kk, v) => { if (v !== undefined && v !== null && v !== "") { const d = el("div"); d.append(el("dt", "", kk), el("dd", "", v)); dl.append(d); } };
    row("Solicitud", oc.solicitudId);
    row("Proveedor", solSupplier.get(oc.solicitudId) || oc.proveedorId);
    row("Centro de costo", oc.centroCosto);
    row("Fecha", oc.fecha);
    if (oc.total !== undefined) row("Total", fmtMoney(oc.total, oc.moneda));
    r.append(dl);
    if (oc.comentarioAprobador) { const q = el("p", "quote"); q.append(el("strong", "", "Comentario del aprobador: "), document.createTextNode(oc.comentarioAprobador)); r.append(q); }
    log.append(r); scroll();
  }

  // Tarjeta de bloqueo: por que no se crea la orden y que hacer. Es la unica vez que se detalla el motivo completo.
  function addBlocked(controles, text) {
    const box = el("section", "blockbox");
    box.setAttribute("role", "note");
    const h = el("h2", "bt"); h.append(pill("falla", "✕", OUTCOME.bloqueada), document.createTextNode(" No se creó la orden"));
    box.append(h);
    const fs = failures(controles);
    if (fs.length) {
      const ul = el("ul");
      for (const f of fs) ul.append(el("li", "", `${f.id} ${f.nombre}: ${f.detalle}`));
      box.append(el("p", "bw", "Motivo:"), ul);
      box.append(el("p", "bnext", "Qué hacer: " + (fs[0].accion || "corrige la solicitud y vuelve a procesarla.")));
    } else {
      box.append(el("p", "bw", String(text || "").replace(/^No se puede crear la OC\.\s*/, "")), el("p", "bnext", "Qué hacer: corrige la solicitud y vuelve a procesarla."));
    }
    log.append(box); scroll();
  }

  function addRejected(motivo) {
    const box = el("section", "rejectbox");
    box.setAttribute("role", "note");
    const h = el("h2", "bt"); h.append(pill("", "✕", OUTCOME.rechazada), document.createTextNode(" No se creó la orden"));
    box.append(h);
    if (motivo) { const q = el("p", "quote"); q.append(el("strong", "", "Motivo: "), document.createTextNode(motivo)); box.append(q); }
    log.append(box); scroll();
  }

  function addNotice(e) { log.append(el("div", "notice " + (e.level === "error" ? "error" : ""), e.text)); scroll(); }

  // El costo del turno vive en el panel "Traza y costo"; en el chat solo se muestra si la persona lo activa (apagado por defecto).
  function addUsage(u) {
    log.append(el("div", "usage", `${u.calls} llamada(s) · ${k(u.input)} entrada · ${k(u.output)} salida · caché ${k(u.cacheRead)} leída / ${k(u.cacheWrite)} escrita · ≈ US$ ${u.costUsd.toFixed(4)}`));
    flushOutcome();
    scroll();
    if (!replaying) loadTrace();
  }

  function addConfirmation(p) {
    dropEmpty();
    const v = p.vista;
    const structured = v && Array.isArray(v.lineas);
    const card = el("section", "gate" + (structured ? " structured" : ""));
    card.setAttribute("role", "group");
    card.tabIndex = -1;
    const titleId = "gate-" + p.pendingId;
    card.setAttribute("aria-labelledby", titleId);

    const head = el("div", "gate-head");
    const gi = el("div", "gate-icon", "●"); gi.setAttribute("aria-hidden", "true");
    const ht = el("div", "gate-title");
    const title = el("h2", "", "Se requiere tu aprobación"); title.id = titleId;
    const sub = el("p", "gate-sub", p.resumen);
    ht.append(title, sub);
    const toggle = el("button", "btn btn-quiet gate-toggle", "Ver detalle"); toggle.type = "button"; toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = () => { const o = card.classList.toggle("open"); toggle.textContent = o ? "Ocultar detalle" : "Ver detalle"; toggle.setAttribute("aria-expanded", String(o)); };
    head.append(gi, ht, toggle);

    const body = el("div", "gate-body");
    body.append(el("p", "gate-intro", "Si apruebas, se crea la orden en SAP con estos valores. Si rechazas, no se crea nada: escribe el motivo, que queda registrado."));
    let summary = p.resumen;
    let sol = toolSol.get(p.toolUseId) || "";
    if (structured) {
      sol = v.solicitudId || sol;
      const supplier = `${v.proveedor.nombre} (${v.proveedor.id})`;
      if (v.solicitudId) solSupplier.set(v.solicitudId, supplier);
      const facts = el("dl", "ledger facts");
      const fact = (kk, val, cls) => { const f = el("div", cls); f.append(el("dt", "", kk), el("dd", "", val)); facts.append(f); };
      fact("Solicitud", v.solicitudId);
      fact("Proveedor", supplier);
      fact("Centro de costo", v.centroCosto);
      fact("Total", fmtMoney(v.total, v.moneda), "total");
      body.append(facts);
      summary = `${v.solicitudId} · ${v.proveedor.nombre} · ${fmtMoney(v.total, v.moneda)}`;

      const t = el("table", "lineas");
      const th = el("thead"); const h = el("tr");
      [["Descripción", ""], ["Cant.", "num"], ["Precio unit.", "num"], ["Subtotal", "num"]].forEach(([x, c]) => { const e1 = el("th", c, x); e1.scope = "col"; h.append(e1); });
      th.append(h); t.append(th);
      const tb = el("tbody");
      for (const l of v.lineas) {
        const r = el("tr");
        r.append(el("td", "", l.descripcion), el("td", "num", fmtNum(l.cantidad)), el("td", "num", fmtNum(l.precioUnitario)), el("td", "num", fmtNum(l.subtotal)));
        tb.append(r);
      }
      t.append(tb);
      const tw = el("div", "tablewrap"); tw.append(t);
      body.append(el("h3", "subh", "Líneas"), tw);

      // Controles: resumen de una linea; la tabla se abre sola solo si hay alertas o fallas (cuando todo pasa, no estorba).
      const ctl = Array.isArray(v.controles) ? v.controles : [];
      const nOk = ctl.filter((c) => c.resultado === "OK").length, nAl = ctl.filter((c) => c.resultado === "ALERTA").length, nFa = ctl.filter((c) => c.resultado === "FALLA").length;
      const cd = el("details", "ctrl-details");
      if (nAl || nFa) cd.open = true;
      const cs = el("summary", "", nAl || nFa ? `Controles: ${nOk} OK · ${nAl} ${nAl === 1 ? "alerta" : "alertas"}${nFa ? ` · ${nFa} fallas` : ""}` : `Controles: ${nOk} de ${ctl.length} OK`);
      cd.append(cs, controlsTable(ctl));
      body.append(cd);

      if (v.alertas && v.alertas.length) {
        const co = el("aside", "margin-note"); co.setAttribute("role", "note");
        const hd = el("p", "mn-head"); const ic = el("span", "ic", "▲"); ic.setAttribute("aria-hidden", "true");
        hd.append(ic, document.createTextNode(` ${v.alertas.length} alerta(s) para considerar al decidir`));
        const ul = el("ul"); for (const a of v.alertas) ul.append(el("li", "", `${a.id} ${a.nombre}: ${a.detalle}`));
        co.append(hd, ul); body.append(co);
      }
    } else {
      body.append(el("pre", "", json(v)));
    }

    const form = el("div", "formrow");
    const taId = "c-" + p.pendingId, errId = "e-" + p.pendingId;
    const lab = el("label", "", "Motivo o comentario (obligatorio para rechazar)"); lab.htmlFor = taId;
    const ta = el("textarea"); ta.id = taId; ta.rows = 2; ta.maxLength = 1000; ta.placeholder = "Queda registrado junto con tu decisión";
    ta.setAttribute("aria-describedby", errId);
    const fieldErr = el("p", "field-error"); fieldErr.id = errId; fieldErr.setAttribute("role", "alert"); fieldErr.hidden = true;
    ta.addEventListener("input", () => { fieldErr.hidden = true; fieldErr.textContent = ""; ta.removeAttribute("aria-invalid"); });
    form.append(lab, ta, fieldErr);
    const actions = el("div", "gate-actions");
    const ok = el("button", "btn btn-primary", "Aprobar y crear OC"), no = el("button", "btn btn-outline", "Rechazar");
    ok.type = no.type = "button";
    ok.onclick = () => decide(p.pendingId, "aprobar", ta);
    no.onclick = () => {
      if (!ta.value.trim()) { // rechazar exige motivo (queda en el registro)
        fieldErr.textContent = "Escribe el motivo del rechazo para continuar.";
        fieldErr.hidden = false; ta.setAttribute("aria-invalid", "true"); ta.focus();
        return;
      }
      decide(p.pendingId, "rechazar", ta);
    };
    actions.append(ok, no, el("p", "gate-note", "Al aprobar se crea la OC en SAP (simulado)."));
    body.append(form, actions);

    card.append(head, body);
    log.append(card);
    confirmCards.set(p.pendingId, { card, title, sub, ta, ok, no, summary, toolUseId: p.toolUseId, sol });
    flowSet(0, "done"); flowSet(1, "done"); flowSet(2, "run"); flowPending();
    if (sol) setSolStatus(sol, "aprobacion");
    // La fila de la herramienta pasa DEBAJO de la tarjeta: primero la decision, luego su efecto.
    const tc = toolCards.get(p.toolUseId);
    if (tc) { swapStatus(tc, "alerta", "…", OUTCOME.pendiente); log.append(tc.d); }
    announce("Se requiere tu aprobación para crear la orden.");
    card.scrollIntoView({ block: "start" });
    card.focus({ preventScroll: true });
  }

  function markResolved(e) {
    const c = confirmCards.get(e.pendingId);
    if (!c) return;
    const ap = e.decision === "aprobar";
    c.card.classList.add("resolved", ap ? "aprobar" : "rechazar");
    c.card.classList.remove("open");
    c.card.querySelector(".gate-icon").textContent = ap ? "✓" : "✕";
    const tc = toolCards.get(c.toolUseId);
    if (ap) { flowSet(2, "done"); flowSet(3, "run"); if (flow) { flow.outcome = ""; renderStepper(); } if (tc) { tc.label.textContent = "Creando la orden en SAP"; swapStatus(tc, "run", "spin", "en curso"); } }
    else flowSet(2, "blocked", OUTCOME.rechazada);
    c.title.textContent = ap ? "Aprobaste crear esta OC" : "Rechazaste crear esta OC";
    c.sub.textContent = c.summary + (e.comentario ? ` · Comentario: ${e.comentario}` : "");
    [c.ok, c.no, c.ta].forEach((x) => (x.disabled = true));
    c.card.removeAttribute("tabindex");
  }

  function renderEvent(e) {
    switch (e.type) {
      case "user_text": turn = newTurn(); addMsg("user", e.text); break;
      case "assistant_text": addMsg("assistant", e.text); break;
      case "tool_call": addToolCall(e); break;
      case "tool_result": addToolResult(e); break;
      case "pending_confirmation": addConfirmation(e.pending); break;
      case "decision": turn = newTurn(); turn.processing = true; turn.motivo = e.comentario || ""; markResolved(e); break;
      case "notice": addNotice(e); break;
      case "usage": addUsage(e.usage); break;
    }
  }

  // ---------- red ----------
  async function readError(res) {
    const data = await res.json().catch(() => null);
    const msg = data?.error?.message || `Error ${res.status}`;
    if (data?.error?.code === "missing_api_key") showBanner(msg);
    const retryAfter = Number.parseInt(res.headers.get("retry-after") || "", 10);
    return Object.assign(new Error(msg), { http: true, code: data?.error?.code, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60 });
  }

  /** POST que responde SSE. Consume el stream y renderiza los eventos `ui`. */
  async function streamPost(url, body, myGen, onAccepted) {
    ctrl = new AbortController();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw await readError(res);
    if (onAccepted) onAccepted();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let gotDone = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        let ev = "message", data = "";
        for (const l of block.split(/\r?\n/)) {
          if (l.startsWith("event:")) ev = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        if (ev === "done") gotDone = true;
        if (myGen !== gen || !data) continue; // respuesta vieja (o comentario keep-alive ": ping"): se ignora
        if (ev === "ui") {
          const e = JSON.parse(data);
          if (e.type === "pending_confirmation") pendingId = e.pending.pendingId;
          renderEvent(e);
          if (e.type === "decision" && e.pendingId === pendingId) pendingId = null;
          if (e.type === "pending_confirmation") refreshControls();
        }
      }
    }
    // El stream se cerro sin el evento final `done`: el turno pudo terminar (o seguir) en el servidor; se repinta desde alla.
    if (!gotDone && myGen === gen) throw Object.assign(new Error("Se interrumpió la conexión con el servidor; recuperando el estado de la conversación…"), { streamCut: true });
  }

  // Limite de peticiones (429): aviso con cuenta regresiva (segun Retry-After) y boton para reintentar.
  let rateTimer = null;
  function clearRateNotice() { clearInterval(rateTimer); rateTimer = null; $("rate-notice")?.remove(); }
  function showRateLimit(msg, seconds, retry) {
    clearRateNotice();
    const box = el("div", "notice rate-notice"); box.id = "rate-notice";
    box.append(el("span", "", msg + " "));
    const b = el("button", "btn btn-quiet", ""); b.type = "button";
    let left = seconds;
    const paint = () => { b.disabled = left > 0; b.textContent = left > 0 ? `Reintentar en ${left} s` : "Reintentar"; };
    paint();
    rateTimer = setInterval(() => { left--; paint(); if (left <= 0) { clearInterval(rateTimer); rateTimer = null; } }, 1000);
    b.onclick = () => { clearRateNotice(); retry(); };
    box.append(b);
    log.append(box); scroll();
    announce(msg);
  }

  async function run(url, body, onAccepted, retry) {
    const myGen = gen;
    clearRateNotice();
    setBusy(true);
    try {
      await streamPost(url, body, myGen, onAccepted);
    } catch (e) {
      if (myGen !== gen || e.name === "AbortError") return;
      if (e.code === "rate_limit" && retry) showRateLimit(e.message, e.retryAfter || 60, retry);
      else addNotice({ level: "error", text: e.message || "No se pudo completar la solicitud." });
      throw e;
    } finally {
      if (myGen === gen) { setBusy(false); if (!pendingId) input.focus(); }
    }
  }

  // Devuelve true si el mensaje se acepto; si la app no esta lista, NO se descarta: el texto queda y se explica por que.
  function send(text, onAccepted) {
    text = text.trim();
    if (!text) return false;
    if (restoring) { showHint("Cargando la conversación… tu mensaje se conserva; envíalo cuando termine."); return false; }
    if (restoreFailed) { showHint("No se pudo cargar esta conversación. Empieza una nueva para continuar; tu mensaje se conserva."); return false; }
    if (busy) { showHint("El agente sigue trabajando; espera a que termine."); return false; }
    if (pendingId) { showHint("Hay una aprobación pendiente: resuélvela para continuar."); return false; }
    showHint("");
    run("/api/chat", { sessionId, mensaje: text }, onAccepted, () => send(text, onAccepted)).catch((e) => { if (!e.http || e.code === "sesion_ocupada") restore(); });
    return true;
  }

  async function decide(id, decision, ta) {
    const c = confirmCards.get(id);
    if (busy || !c || id !== pendingId) return;
    const comentario = ta.value.trim();
    if (decision === "rechazar" && !comentario) return; // la tarjeta ya pide el motivo; el servidor tambien lo exige
    [c.ok, c.no, c.ta].forEach((x) => (x.disabled = true)); // evita doble click mientras viaja (run() ademas pone busy)
    try {
      // La tarjeta sigue activa hasta que el servidor acepta; entonces llega el evento "decision".
      await run("/api/confirm", { sessionId, pendingId: id, decision, ...(comentario ? { comentario } : {}) }, undefined, () => decide(id, decision, ta));
    } catch (e) {
      // Error reintentable (red, 429, 5xx): se reactivan los botones. Si el servidor dice que ya no es valida
      // (consumida) o el stream se corto, se repinta el estado real desde el servidor.
      // Solo si la tarjeta sigue siendo la pendiente (si ya llego "decision", no se reactiva una tarjeta resuelta).
      if (id === pendingId) refreshControls(); else [c.ok, c.no, c.ta].forEach((x) => (x.disabled = true));
      if (!e.http || e.code === "confirmacion_invalida" || e.code === "sesion_ocupada") restore();
    }
  }

  // Vuelve a pintar la sesion desde el servidor (recarga, o tras un corte a mitad de stream).
  // Con tope de espera: si el servidor no responde, avisa y ofrece empezar una conversacion nueva.
  async function restore() {
    const myGen = gen;
    restoring = true; restoreFailed = false;
    refreshControls();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RESTORE_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/sesion/${sessionId}`, { signal: ac.signal });
      if (!res.ok) throw new Error(String(res.status));
      const s = await res.json();
      if (myGen !== gen) return;
      clearLog();
      replaying = true;
      try {
        pendingId = s.pending ? s.pending.pendingId : null;
        for (const e of s.events) renderEvent(e);
      } finally { replaying = false; }
      pendingId = s.pending ? s.pending.pendingId : null;
      for (const o of s.ordenes || []) { solStatus.set(o.solicitudId, "creada"); solOc.set(o.solicitudId, o.numero); }
      renderQuick();
      if ($("empty")) $("empty").replaceWith(renderEmpty());
      if (s.events.length > 0) dropEmpty();
      if (s.busy) {
        // El servidor sigue con un turno (recarga a mitad de turno): la UI sigue ocupada y consulta hasta que termine.
        busy = true;
        pollUntilFree(myGen);
      } else {
        busy = false;
        // Tarjetas de tools que quedaron sin resultado (turno cortado) no deben mostrar "ejecutando…" para siempre.
        toolCards.forEach((c) => { if (c.status.classList.contains("running")) swapStatus(c, "", "–", "sin resultado"); });
      }
      removeRestoreNotice();
    } catch (e) {
      if (myGen !== gen) return;
      restoreFailed = true;
      showRestoreNotice(e && e.name === "AbortError" ? "La conversación anterior tardó demasiado en cargar." : "No se pudo cargar la conversación anterior.");
    } finally {
      clearTimeout(timer);
      if (myGen === gen) { restoring = false; refreshControls(); if (!restoreFailed) { showHint(""); loadTrace(); } }
    }
  }

  // Mientras el servidor tenga un turno en curso no se habilita el input ni la aprobacion; al liberarse se repinta todo.
  let pollTimer = null;
  function pollUntilFree(myGen, tries = 0) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (myGen !== gen) return;
      let free = tries >= 100; // ~2.5 min: no se queda ocupado para siempre
      try {
        const res = await fetch(`/api/sesion/${sessionId}`, { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) });
        if (res.ok) free = !(await res.json()).busy;
      } catch { /* reintenta */ }
      if (myGen !== gen) return;
      if (free) { busy = false; restore(); } else pollUntilFree(myGen, tries + 1);
    }, 1500);
  }

  function removeRestoreNotice() { $("restore-notice")?.remove(); }
  function showRestoreNotice(text) {
    removeRestoreNotice();
    const box = el("div", "notice error restore-notice");
    box.id = "restore-notice";
    box.append(el("span", "", text + " "));
    const b = el("button", "btn btn-quiet", "Empezar nueva conversación");
    b.type = "button"; b.onclick = doReset;
    const r = el("button", "btn btn-quiet", "Reintentar");
    r.type = "button"; r.onclick = () => restore();
    box.append(b, r);
    log.prepend(box);
    showHint("No se pudo cargar esta conversación. Empieza una nueva para continuar.");
  }

  // "Nueva conversacion": si hay algo que perder, pide confirmacion y explica que empieza con un SAP simulado limpio.
  const dlg = $("reset-dialog");
  function reset() {
    if (!$("empty") || pendingId) {
      if (dlg && typeof dlg.showModal === "function") { $("reset-pending").hidden = !pendingId; dlg.showModal(); return; }
      if (!confirm("¿Empezar una conversación nueva? Se borra esta conversación y empiezas con un SAP simulado limpio.")) return;
    }
    return doReset();
  }
  if (dlg) {
    $("reset-cancel").onclick = () => dlg.close();
    $("reset-ok").onclick = () => { dlg.close(); doReset(); };
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); }); // clic en el fondo
  }

  async function doReset() {
    const myGen = ++gen;
    clearRateNotice(); // las respuestas de la peticion en curso (y de init/restore/poll viejos) quedan obsoletas
    clearTimeout(pollTimer);
    if (ctrl) ctrl.abort();
    const old = sessionId;
    sessionId = newId();
    try { sessionStorage.setItem("sid", sessionId); } catch { /* ignorado */ }
    // Sigue "ocupada" (restoring) hasta que termine init(false): evita enviar mientras salud/solicitudes aun cargan.
    pendingId = null; busy = false; restoring = true; restoreFailed = false;
    showHint("");
    clearLog(); // unico clearLog de la secuencia: init(false) NO vuelve a limpiar el log
    $("trace").replaceChildren(el("p", "muted small", "Aún sin actividad."));
    refreshControls();
    showBanner("");
    closeDrawer();
    fetch(`/api/sesion/${old}/reset`, { method: "POST" }).catch(() => {}); // limpieza del servidor, mejor esfuerzo (409 si aun corria un turno: la sesion vieja expira sola)
    await init(false, myGen);
  }

  // ---------- cajon lateral (movil) ----------
  const drawerBtn = $("drawer-toggle"), scrim = $("scrim"), side = $("side");
  const behind = () => [document.querySelector(".app-head"), $("banner"), document.querySelector(".chat")].filter(Boolean);
  // Con el cajon abierto el resto de la pagina queda inerte (sin foco ni lectura) y el panel actua como dialogo modal.
  function openDrawer() {
    document.body.classList.add("drawer-open"); scrim.hidden = false; drawerBtn.setAttribute("aria-expanded", "true");
    behind().forEach((n) => { n.inert = true; });
    side.setAttribute("role", "dialog"); side.setAttribute("aria-modal", "true");
    $("drawer-close").focus();
  }
  function releaseDrawer() {
    document.body.classList.remove("drawer-open"); scrim.hidden = true; drawerBtn.setAttribute("aria-expanded", "false");
    behind().forEach((n) => { n.inert = false; });
    side.removeAttribute("role"); side.removeAttribute("aria-modal");
  }
  function closeDrawer() { if (!document.body.classList.contains("drawer-open")) return; releaseDrawer(); drawerBtn.focus(); }
  drawerBtn.onclick = () => (document.body.classList.contains("drawer-open") ? closeDrawer() : openDrawer());
  $("drawer-close").onclick = closeDrawer;
  scrim.onclick = closeDrawer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  matchMedia("(min-width: 901px)").addEventListener("change", (m) => { if (m.matches) releaseDrawer(); });
  SHORT.addEventListener("change", refreshControls);

  // Ayuda del SAP simulado (por conversacion) y preferencia de costos en el chat.
  const sapHelp = $("sap-help");
  sapHelp.onclick = () => { const open = $("sap-help-text").hidden; $("sap-help-text").hidden = !open; sapHelp.setAttribute("aria-expanded", String(open)); };
  const usageToggle = $("show-usage");
  try { usageToggle.checked = localStorage.getItem("showUsage") === "1"; } catch { /* sin storage */ }
  const applyUsage = () => document.body.classList.toggle("show-usage", usageToggle.checked);
  applyUsage();
  usageToggle.addEventListener("change", () => { applyUsage(); try { localStorage.setItem("showUsage", usageToggle.checked ? "1" : "0"); } catch { /* ignorado */ } });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = input.value;
    // El texto se borra solo cuando el SERVIDOR acepta la peticion (200); ante 400/409/429/503 o un fallo de red se conserva.
    send(t, () => { if (input.value === t) { input.value = ""; input.style.height = ""; } });
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; });
  resetBtn.onclick = reset;

  function setHealth(state, text) {
    const b = $("health-badge");
    b.dataset.state = state;
    $("health-text").textContent = text;
  }

  async function loadHealth() {
    try {
      const h = await (await fetch("/api/health", { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) })).json();
      mock = !!h.mock;
      if (h.limits && Number.isInteger(h.limits.mensajeChars)) input.maxLength = h.limits.mensajeChars; // tope informado por el servidor (unica fuente)
      document.body.classList.toggle("mock", mock);
      $("mode-badge").hidden = !mock;
      document.title = mock ? "[SIMULADO] Agente OC" : "Agente OC";
      if (mock) { setHealth("ok", "Servidor listo"); showBanner(""); }
      else if (!h.hasApiKey) { setHealth("err", "Sin clave API"); showBanner("El agente no está configurado: falta ANTHROPIC_API_KEY en el servidor. Las acciones del chat no funcionarán hasta definirla."); }
      else { setHealth("ok", "Servidor listo"); }
    } catch { setHealth("err", "Sin conexión"); showBanner("No se pudo contactar al servidor."); }
  }
  async function loadSolicitudes(myGen = gen) {
    try {
      const data = await (await fetch("/api/solicitudes", { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) })).json();
      solicitudes = data.solicitudes || [];
    } catch { /* sin solicitudes */ }
    if (myGen !== gen) return; // llego tras "Nueva conversacion": no toca la conversacion nueva
    // Pinta la barra lateral y el estado vacio sin esperar la restauracion de la sesion.
    if ($("empty")) $("empty").replaceWith(renderEmpty());
    renderQuick();
    refreshControls();
  }

  // Salud, solicitudes y restauracion de la sesion corren en paralelo e independientes.
  async function init(first = true, myGen = gen) {
    renderQuick();
    const tasks = [loadHealth(), loadSolicitudes(myGen)];
    if (first) tasks.push(restore());
    await Promise.all(tasks);
    if (!first && myGen === gen) { restoring = false; refreshControls(); }
  }
  // Enlace de descarga de la auditoría: el sessionId cambia con "Nueva conversación", así que se resuelve al hacer clic.
  const auditLink = $("audit-link");
  const auditUrl = () => `/api/sesion/${sessionId}/auditoria`;
  auditLink.href = auditUrl();
  auditLink.addEventListener("click", () => { auditLink.href = auditUrl(); auditLink.download = `auditoria-${sessionId.slice(0, 8)}.json`; });
  clearLog();
  init();
})();
