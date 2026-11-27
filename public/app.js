// Frontend sin build. El estado de la conversacion vive en el servidor (Durable Object por sesion):
// aqui solo se guarda el sessionId (sessionStorage). Todo el texto se inserta con textContent (nunca innerHTML).
(() => {
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), sendBtn = $("send"), loading = $("loading"), banner = $("banner"), resetBtn = $("reset"), scroller = $("scroller");

  const newId = () => crypto.randomUUID();
  let sessionId;
  try { sessionStorage.setItem("sid", (sessionId = sessionStorage.getItem("sid") || newId())); } catch { sessionId = sessionId || newId(); }

  let busy = false, gen = 0, ctrl = null, restoring = true, restoreFailed = false, replaying = false;
  let solicitudes = [];
  let pendingCaso = null; // caso con confirmacion pendiente (segun el servidor)
  const RESTORE_TIMEOUT_MS = 6000;
  const toolCards = new Map(); // id -> { d, status, ms, sum, body, name }
  const gates = new Map(); // caso -> { card, ok, no }
  const SHORT = matchMedia("(max-width: 760px)");

  // ---------- utilidades ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const json = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("es-CO") : String(n));
  const fmtMoney = (n, cur) => `${fmtNum(n)} ${cur || "COP"}`;
  const clock = (ts) => { if (!ts && replaying) return ""; const d = ts ? new Date(ts) : new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const scroll = () => { scroller.scrollTop = scroller.scrollHeight; };
  const srStatus = $("sr-status"), srReply = $("sr-reply");
  const announceReply = (t) => { if (replaying || !t) return; srReply.textContent = ""; setTimeout(() => { srReply.textContent = "Respuesta del agente: " + t; }, 60); };
  const showBanner = (msg) => { banner.textContent = msg || ""; banner.hidden = !msg; };
  const hint = $("composer-hint");
  const showHint = (msg) => { hint.textContent = msg || ""; hint.hidden = !msg; };
  const dropEmpty = () => $("empty")?.remove();

  function pill(kind, icon, label) {
    const p = el("span", "pill " + kind);
    if (icon === "spin") p.classList.add("running");
    else if (icon) { const i = el("span", "ic", icon); i.setAttribute("aria-hidden", "true"); p.append(i); }
    p.append(document.createTextNode(label));
    return p;
  }
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
        if (b) { p = null; if (!ul) { ul = el("ul"); box.append(ul); } const li = el("li"); li.append(inline(b[1])); ul.append(li); }
        else { ul = null; if (!p) { p = el("p"); box.append(p); } else p.append(document.createElement("br")); p.append(inline(line)); }
      }
    }
    return box;
  }
  const table = (cls, heads, rows) => {
    const wrap = el("div", "tablewrap");
    const t = el("table", cls);
    const h = el("tr");
    heads.forEach(([x, c]) => { const th = el("th", c, x); th.scope = "col"; h.append(th); });
    const thead = el("thead"); thead.append(h);
    const tb = el("tbody");
    rows.forEach((r) => { const tr = el("tr"); r.forEach(([x, c]) => tr.append(el("td", c, x))); tb.append(tr); });
    t.append(thead, tb); wrap.append(t);
    return wrap;
  };

  // ---------- lenguaje llano para herramientas ----------
  const TOOL_LABEL = {
    oc_leer_paquete: "Leyendo el paquete (correo, solicitud, cotización, aprobación)",
    oc_validar: "Validando las reglas de control RC1–RC10",
    oc_construir_payload: "Construyendo la OC como quedaría en SAP",
    oc_generar_evidencia: "Generando la evidencia de aprobación",
    oc_crear: "Creando la OC en SAP (simulado)",
  };
  const toolLabel = (n) => TOOL_LABEL[n] || n;
  const codes = (xs) => (xs || []).map((x) => x.codigo).join(", ");
  function toolPill(e) {
    const o = e.output;
    if (e.name === "oc_validar" && e.ok) {
      if (!o.apta) return ["falla", "✕", `No apta · ${codes(o.bloqueos)}`];
      if (o.confirmaciones.length) return ["alerta", "▲", `Apta · requiere confirmar ${codes(o.confirmaciones)}`];
      return ["ok", "✓", "Apta sin excepciones"];
    }
    if (e.name === "oc_crear") {
      if (e.ok) return o.idempotente ? ["", "ℹ", "Ya existía (idempotente)"] : ["ok", "✓", "OC creada"];
      if (o && o.pendiente) return ["alerta", "▲", "Pendiente de confirmación"];
      if (o && o.bloqueos) return ["falla", "✕", "Bloqueada"];
    }
    return e.ok ? ["ok", "✓", "Listo"] : ["error", "✕", "Error"];
  }
  function toolSummary(e) {
    const o = e.output;
    if (!e.ok) return typeof o === "object" && o && o.error ? String(o.error).slice(0, 140) : "No se pudo completar";
    switch (e.name) {
      case "oc_leer_paquete": return `Paquete de ${o.solicitud.solicitud_id}` + (o.faltantes.length ? ` · faltan: ${o.faltantes.join(", ")}` : "");
      case "oc_validar": return `${o.bloqueos.length} bloqueos · ${o.confirmaciones.length} confirmaciones` + (o.retroactiva ? " · retroactiva" : "");
      case "oc_construir_payload": return `Trazabilidad en ${o.trazabilidad}`;
      case "oc_generar_evidencia": return `${o.ruta} · sha256 ${o.sha256.slice(0, 12)}…`;
      case "oc_crear": return `OC ${o.numero_oc}`;
      default: return "";
    }
  }

  // ---------- render de eventos ----------
  function addMsg(role, text) {
    dropEmpty();
    if (role === "user") { log.append(el("div", "msg user", text)); scroll(); return; }
    const m = el("div", "msg assistant");
    m.append(el("p", "who", "Agente"), prose(text));
    log.append(m); scroll();
    announceReply(text);
  }
  function addToolCall(e) {
    dropEmpty();
    const d = el("details", "tool");
    const s = el("summary");
    const status = pill("run", "spin", "en curso");
    const ms = el("span", "ms");
    const main = el("span", "tmain");
    const sum = el("span", "tsum");
    main.append(el("span", "tlabel", toolLabel(e.name)), sum);
    s.append(main, status, el("time", "tm", clock(e.ts)), el("span", "more", "Ver detalle técnico"));
    const body = el("div", "body");
    const tech = el("p", "techline"); tech.append(el("code", "name", e.name), ms);
    body.append(tech, el("p", "subh", "Argumentos"), el("pre", "", json(e.input)));
    d.append(s, body); log.append(d);
    toolCards.set(e.id, { d, status, ms, sum, body });
    scroll();
  }
  function addToolResult(e) {
    const c = toolCards.get(e.id);
    if (c) {
      const [kind, icon, label] = toolPill(e);
      const p = pill(kind, icon, label); c.status.replaceWith(p); c.status = p;
      if (e.ms) c.ms.textContent = `${fmtNum(e.ms)} ms`;
      c.sum.textContent = toolSummary(e);
      c.body.append(el("p", "subh", e.ok ? "Resultado (resumen)" : "Error"), el("pre", "", json(e.output)));
    }
    const o = e.output;
    if (e.name === "oc_crear") {
      if (e.ok) { addReceipt(o, e.id); resolveGate(toolCasoDe(e.id), "creada"); }
      else if (o && o.bloqueos) addBlocked(o);
    }
    if (e.name === "oc_validar" && e.ok && !o.apta) addBlocked(o);
    scroll();
  }
  const toolCasos = new Map();
  const toolCasoDe = (id) => toolCasos.get(id) || "";

  function addBlocked(o) {
    const key = "blocked-" + (o.caso || "") + JSON.stringify(o.bloqueos).length;
    if (document.getElementById(key)) return;
    const box = el("section", "notice error");
    box.id = key;
    box.append(el("strong", "", "No se crea la OC · bloqueada"));
    const ul = el("ul");
    for (const b of o.bloqueos) {
      const li = el("li"); li.append(el("strong", "", b.codigo + " "), document.createTextNode(b.detalle || ""));
      if (b.accion_sugerida) { li.append(document.createElement("br"), el("em", "", "Acción sugerida: " + b.accion_sugerida)); }
      ul.append(li);
    }
    if (!o.bloqueos[0] || !o.bloqueos[0].detalle) for (const a of o.acciones_sugeridas || []) ul.append(el("li", "", "Acción sugerida: " + a));
    box.append(ul); log.append(box);
  }
  function addReceipt(o, id) {
    const r = el("section", "receipt");
    const h = el("h2", "rt");
    h.append(pill(o.idempotente ? "" : "ok", o.idempotente ? "ℹ" : "✓", o.idempotente ? "Ya existía" : "OC creada"), document.createTextNode(` ${o.numero_oc}`));
    r.append(h);
    const dl = el("dl", "ledger");
    const row = (k, v) => { if (v !== undefined && v !== null && v !== "") { const d = el("div"); d.append(el("dt", "", k), el("dd", "", v)); dl.append(d); } };
    row("Fecha", o.fecha);
    row("Retroactiva", o.retroactiva ? "Sí (marcada en control.csv)" : "No");
    row("Confirmada por", o.confirmado_por);
    row("Evidencia", o.evidencia);
    r.append(dl);
    if (o.evidencia) {
      const a = el("a", "btn btn-quiet audit-link", "Descargar evidencia (PDF)");
      a.href = `/api/sessions/${sessionId}/out/${o.evidencia_pdf.replace(/^out\//, "")}`; a.download = "aprobacion.pdf";
      r.append(a);
    }
    log.append(r);
  }

  // Tarjeta de confirmacion resaltada (CA3): payload en tabla + confirmaciones con ambos valores + derivados.
  function resolveGate(caso, estado) {
    const g = gates.get(caso);
    if (!g || g.card.classList.contains("resolved")) return;
    g.card.classList.add("resolved");
    g.ok.disabled = g.no.disabled = true;
    g.title.textContent = estado === "creada" ? "Confirmación atendida · OC creada" : "Confirmación ya no está pendiente";
  }
  function addConfirmation(p) {
    dropEmpty();
    gates.get(p.caso)?.card.remove();
    const card = el("section", "gate open");
    card.setAttribute("role", "group"); card.tabIndex = -1;
    const head = el("div", "gate-head");
    const gi = el("div", "gate-icon", "●"); gi.setAttribute("aria-hidden", "true");
    const ht = el("div", "gate-title");
    const title = el("h2", "", "Se requiere tu confirmación"); ht.append(title, el("p", "gate-sub", `${p.solicitud_id} (${p.caso}) · ${p.confirmaciones.length} confirmación(es) pendiente(s)` + (p.retroactiva ? " · OC retroactiva" : "")));
    head.append(gi, ht);
    const body = el("div", "gate-body");
    body.append(el("p", "gate-intro", "No se crea nada hasta que confirmes. Si confirmas, la OC se crea con estos valores y cada excepción queda registrada con tu confirmación."));

    body.append(el("h3", "subh", "Confirmaciones"));
    const ul = el("ul");
    for (const c of p.confirmaciones) {
      const li = el("li"); li.append(el("strong", "", c.codigo + " "), document.createTextNode(c.detalle));
      if (c.valores) {
        const v = c.valores;
        if (v.solicitud !== undefined && v.cotizacion !== undefined) {
          li.append(table("controles", [["Solicitud", "num"], ["Cotización", "num"], ["Diferencia", "num"]], [[[fmtMoney(v.solicitud, v.moneda_solicitud), "num"], [fmtMoney(v.cotizacion, v.moneda_cotizacion), "num"], [`${fmtNum(v.diferencia_pct)} %`, "num"]]]));
        } else li.append(el("pre", "", Object.entries(v).map(([k, x]) => `${k}: ${x}`).join("\n")));
      }
      ul.append(li);
    }
    body.append(ul);
    const dv = Object.entries(p.derivados || {});
    if (dv.length) body.append(el("h3", "subh", "Valores derivados del maestro (informativo)"), table("controles", [["Campo", ""], ["Valor", ""]], dv.map(([k, x]) => [[k, "cid"], [x, ""]])));

    if (p.payload) {
      const o = p.payload;
      body.append(el("h3", "subh", "OC tal como quedaría en SAP"));
      const facts = el("dl", "ledger");
      const fact = (k, v) => { const d = el("div"); d.append(el("dt", "", k), el("dd", "", v)); facts.append(d); };
      fact("Proveedor", `${o.proveedor.nombre} · NIT ${o.proveedor.nit} · SAP ${o.proveedor.codigo_sap}`);
      fact("Sociedad / Org. compras", `${o.sociedad} / ${o.organizacion_compras}`);
      fact("Moneda", o.moneda);
      fact("Condiciones de pago", o.condiciones_pago);
      fact("Aprobador", `${o.aprobador.email} · ${o.aprobador.fecha_aprobacion.slice(0, 10)}`);
      fact("Evidencia sha256", o.aprobador.evidencia_sha256.slice(0, 16) + "…");
      body.append(facts, table("lineas", [["Pos.", "num"], ["Descripción", ""], ["Cant.", "num"], ["Un.", ""], ["Precio unit.", "num"], ["C. costo / subárea", ""], ["IVA", ""]],
        o.posiciones.map((x) => [[x.numero, "num"], [x.descripcion, ""], [fmtNum(x.cantidad), "num"], [x.unidad, ""], [fmtMoney(x.precio_unitario, o.moneda), "num"], [`${x.centro_costo} / ${x.subarea}`, ""], [x.indicador_iva, ""]])));
    }
    const actions = el("div", "gate-actions");
    const ok = el("button", "btn btn-primary", "Confirmo, crear la OC"); ok.type = "button";
    const no = el("button", "btn btn-outline", "No confirmo"); no.type = "button";
    ok.onclick = () => send(`Confirmo la creación de la OC de ${p.caso}.`);
    no.onclick = () => send(`No confirmo la creación de la OC de ${p.caso}; no la crees.`);
    actions.append(ok, no);
    card.append(head, body, actions);
    log.append(card);
    gates.set(p.caso, { card, ok, no, title });
    scroll();
    refreshControls();
  }

  function addNotice(e) { dropEmpty(); log.append(el("div", "notice " + (e.level === "error" ? "error" : e.level), e.text)); scroll(); }
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(".", ",") + "k" : String(n));
  function addUsage(u) { log.append(el("p", "usage muted small", u.simulado ? `Modo simulado · ${u.calls} llamadas` : `${u.calls} llamadas · ${k(u.input)} tokens entrada · ${k(u.output)} salida · ≈ US$ ${u.costUsd.toFixed(4)}`)); }

  function renderEvent(e) {
    switch (e.type) {
      case "user_text": addMsg("user", e.text); break;
      case "assistant_text": addMsg("assistant", e.text); break;
      case "tool_call": { const c = e.input && e.input.caso; if (c) toolCasos.set(e.id, c); addToolCall(e); break; }
      case "tool_result": addToolResult(e); break;
      case "pending_confirmation": pendingCaso = e.pending.caso; addConfirmation(e.pending); break;
      case "notice": addNotice(e); break;
      case "usage": addUsage(e.usage); break;
    }
  }

  // ---------- control de la interfaz ----------
  function refreshControls() {
    loading.hidden = !(busy || restoring);
    $("loading-text").textContent = busy ? "El agente está trabajando…" : "Preparando el agente y cargando la conversación…";
    sendBtn.disabled = busy || restoring;
    input.disabled = busy || restoring;
    input.placeholder = SHORT.matches ? "Escribe o elige una solicitud…" : 'Ej.: "Procesa la solicitud sol-004" o responde «confirmo»';
    document.querySelectorAll("[data-quick]").forEach((c) => (c.disabled = busy || restoring));
    gates.forEach((g) => { if (!g.card.classList.contains("resolved")) g.ok.disabled = g.no.disabled = busy || restoring; });
    resetBtn.disabled = false;
  }
  function setBusy(b) { busy = b; refreshControls(); }

  const quickMessage = (id) => `Procesa la solicitud ${id}. Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no.`;
  const PRD_PROMPT = 'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.';
  function renderEmpty() {
    const box = el("section", "empty"); box.id = "empty";
    box.append(el("h2", "", "Procesa una solicitud de compra"),
      el("p", "lead", "El agente lee el paquete, valida las reglas RC1–RC10, arma la OC y la crea en SAP (simulado). Sin excepciones la crea solo; si hay confirmaciones te las muestra y espera tu «confirmo»; si hay bloqueos no la crea y te dice por qué."));
    const acts = el("div", "actions"); acts.setAttribute("role", "group"); acts.setAttribute("aria-label", "Probar un caso");
    acts.append(el("span", "actions-label", "Probar un caso:"));
    for (const s of solicitudes) {
      const b = el("button", "btn btn-quiet", `Probar ${s.id}`); b.type = "button"; b.dataset.quick = "1"; b.title = s.asunto || "";
      b.onclick = () => send(quickMessage(s.id)); acts.append(b);
    }
    const prd = el("button", "btn btn-outline", "Ejemplo del PRD (sol-004, sin crear)"); prd.type = "button"; prd.dataset.quick = "1"; prd.onclick = () => send(PRD_PROMPT);
    acts.append(prd);
    box.append(acts, el("p", "examples", "También puedes escribir tu petición en el cuadro de abajo."));
    return box;
  }
  function renderQuick() {
    const ul = $("quick"); ul.replaceChildren();
    if (!solicitudes.length) { ul.append(el("li", "muted small", "Sin solicitudes disponibles.")); return; }
    for (const s of solicitudes) {
      const li = el("li");
      const b = el("button", "req"); b.type = "button"; b.dataset.quick = "1";
      const top = el("span", "req-top"); top.append(el("span", "req-id", s.id));
      b.append(top, el("span", "req-sub", s.descripcion || s.asunto || ""));
      if (s.solicitante) b.append(el("span", "req-who", s.solicitante));
      b.onclick = () => { closeDrawer(); send(quickMessage(s.id)); };
      li.append(b); ul.append(li);
    }
    refreshControls();
  }
  function clearLog() {
    toolCards.clear(); gates.clear(); toolCasos.clear(); pendingCaso = null;
    log.replaceChildren(renderEmpty()); renderQuick(); renderFiles([]);
  }

  // ---------- archivos generados (out/) ----------
  function renderFiles(files) {
    const ul = $("files"); ul.replaceChildren();
    if (!files.length) { ul.append(el("li", "muted small", "Aún no hay archivos: se generan al procesar una solicitud.")); return; }
    for (const f of files) {
      const li = el("li", "small");
      const a = el("a", "", f.ruta); a.href = `/api/sessions/${sessionId}/out/${f.ruta}`; a.download = f.ruta.split("/").pop();
      li.append(a, el("span", "muted", ` · ${fmtNum(f.bytes)} B`)); ul.append(li);
    }
  }
  async function loadFiles(myGen = gen) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/out`, { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) });
      if (!res.ok) return;
      const data = await res.json();
      if (myGen === gen) renderFiles(data.archivos || []);
    } catch { /* sin archivos */ }
  }

  // ---------- red ----------
  async function readError(res) {
    const data = await res.json().catch(() => null);
    const msg = data?.error?.message || `Error ${res.status}`;
    if (data?.error?.code === "missing_api_key" || data?.error?.code === "presupuesto_diario") showBanner(msg);
    const ra = Number.parseInt(res.headers.get("retry-after") || "", 10);
    return Object.assign(new Error(msg), { http: true, code: data?.error?.code, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 60 });
  }
  async function streamPost(url, body, myGen, onAccepted) {
    ctrl = new AbortController();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw await readError(res);
    if (onAccepted) onAccepted();
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", gotDone = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        let ev = "message", data = "";
        for (const l of block.split(/\r?\n/)) { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) data += l.slice(5).trim(); }
        if (ev === "done") gotDone = true;
        if (myGen !== gen || !data) continue;
        if (ev === "ui") renderEvent(JSON.parse(data));
      }
    }
    if (!gotDone && myGen === gen) throw Object.assign(new Error("Se interrumpió la conexión con el servidor; recuperando el estado de la conversación…"), { streamCut: true });
  }
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
    box.append(b); log.append(box); scroll();
  }
  async function run(url, body, onAccepted, retry) {
    const myGen = gen;
    clearRateNotice(); setBusy(true);
    try { await streamPost(url, body, myGen, onAccepted); }
    catch (e) {
      if (myGen !== gen || e.name === "AbortError") return;
      if (e.code === "rate_limit" && retry) showRateLimit(e.message, e.retryAfter || 60, retry);
      else addNotice({ level: "error", text: e.message || "No se pudo completar la solicitud." });
      throw e;
    } finally { if (myGen === gen) { setBusy(false); input.focus(); loadFiles(myGen); } }
  }
  function send(text, onAccepted) {
    text = text.trim();
    if (!text) return false;
    if (restoring) { showHint("Cargando la conversación… tu mensaje se conserva; envíalo cuando termine."); return false; }
    if (restoreFailed) { showHint("No se pudo cargar esta conversación. Empieza una nueva para continuar."); return false; }
    if (busy) { showHint("El agente sigue trabajando; espera a que termine."); return false; }
    showHint("");
    run("/api/chat", { sessionId, mensaje: text }, onAccepted, () => send(text, onAccepted)).catch((e) => { if (!e.http || e.code === "sesion_ocupada") restore(); });
    return true;
  }

  async function restore() {
    const myGen = gen;
    restoring = true; restoreFailed = false; refreshControls();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RESTORE_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { signal: ac.signal });
      if (!res.ok) throw new Error(String(res.status));
      const s = await res.json();
      if (myGen !== gen) return;
      clearLog();
      replaying = true;
      try { for (const e of s.events) renderEvent(e); } finally { replaying = false; }
      const activo = s.pending ? s.pending.caso : null;
      if (s.pending && !gates.has(activo)) renderEvent({ type: "pending_confirmation", pending: s.pending });
      gates.forEach((_g, caso) => { if (caso !== activo) resolveGate(caso, "cerrada"); });
      pendingCaso = activo;
      if (s.events.length > 0) dropEmpty();
      if (s.busy) { busy = true; pollUntilFree(myGen); }
      else { busy = false; toolCards.forEach((c) => { if (c.status.classList.contains("running")) { const p = pill("", "–", "sin resultado"); c.status.replaceWith(p); c.status = p; } }); }
      $("restore-notice")?.remove();
      loadFiles(myGen);
    } catch (e) {
      if (myGen !== gen) return;
      restoreFailed = true;
      showRestoreNotice(e && e.name === "AbortError" ? "La conversación anterior tardó demasiado en cargar." : "No se pudo cargar la conversación anterior.");
    } finally {
      clearTimeout(timer);
      if (myGen === gen) { restoring = false; refreshControls(); if (!restoreFailed) showHint(""); }
    }
  }
  let pollTimer = null;
  function pollUntilFree(myGen, tries = 0) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (myGen !== gen) return;
      let free = tries >= 100;
      try { const res = await fetch(`/api/sessions/${sessionId}`, { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) }); if (res.ok) free = !(await res.json()).busy; } catch { /* reintenta */ }
      if (myGen !== gen) return;
      if (free) { busy = false; restore(); } else pollUntilFree(myGen, tries + 1);
    }, 1500);
  }
  function showRestoreNotice(text) {
    $("restore-notice")?.remove();
    const box = el("div", "notice error restore-notice"); box.id = "restore-notice";
    box.append(el("span", "", text + " "));
    const b = el("button", "btn btn-quiet", "Empezar nueva conversación"); b.type = "button"; b.onclick = doReset;
    const r = el("button", "btn btn-quiet", "Reintentar"); r.type = "button"; r.onclick = () => restore();
    box.append(b, r); log.prepend(box);
  }

  const dlg = $("reset-dialog");
  function reset() {
    if (!$("empty")) {
      if (dlg && typeof dlg.showModal === "function") { $("reset-pending").hidden = !pendingCaso; dlg.showModal(); return; }
      if (!confirm("¿Empezar una conversación nueva? Se borra esta conversación y su SAP simulado.")) return;
    }
    return doReset();
  }
  if (dlg) {
    $("reset-cancel").onclick = () => dlg.close();
    $("reset-ok").onclick = () => { dlg.close(); doReset(); };
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
  }
  async function doReset() {
    const myGen = ++gen;
    clearRateNotice(); clearTimeout(pollTimer);
    if (ctrl) ctrl.abort();
    const old = sessionId;
    sessionId = newId();
    try { sessionStorage.setItem("sid", sessionId); } catch { /* ignorado */ }
    busy = false; restoring = true; restoreFailed = false;
    showHint(""); clearLog(); refreshControls(); showBanner(""); closeDrawer();
    fetch(`/api/sessions/${old}/reset`, { method: "POST" }).catch(() => {});
    await init(false, myGen);
  }

  // ---------- cajon lateral (movil) ----------
  const drawerBtn = $("drawer-toggle"), scrim = $("scrim"), side = $("side");
  const behind = () => [document.querySelector(".skip"), document.querySelector(".app-head"), $("banner"), document.querySelector(".chat")].filter(Boolean);
  function openDrawer() {
    document.body.classList.add("drawer-open"); scrim.hidden = false; drawerBtn.setAttribute("aria-expanded", "true");
    behind().forEach((n) => { n.inert = true; });
    side.setAttribute("role", "dialog"); side.setAttribute("aria-modal", "true"); $("drawer-close").focus();
  }
  function releaseDrawer() {
    document.body.classList.remove("drawer-open"); scrim.hidden = true; drawerBtn.setAttribute("aria-expanded", "false");
    behind().forEach((n) => { n.inert = false; }); side.removeAttribute("role"); side.removeAttribute("aria-modal");
  }
  function closeDrawer() { if (!document.body.classList.contains("drawer-open")) return; releaseDrawer(); drawerBtn.focus(); }
  drawerBtn.onclick = () => (document.body.classList.contains("drawer-open") ? closeDrawer() : openDrawer());
  $("drawer-close").onclick = closeDrawer; scrim.onclick = closeDrawer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  side.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !document.body.classList.contains("drawer-open")) return;
    const f = [...side.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && !n.closest("[hidden]") && n.getClientRects().length > 0);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !side.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !side.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  matchMedia("(min-width: 901px)").addEventListener("change", (m) => { if (m.matches) releaseDrawer(); });
  SHORT.addEventListener("change", refreshControls);

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
    send(t, () => { if (input.value === t) { input.value = ""; input.style.height = ""; } });
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; });
  resetBtn.onclick = reset;

  function setHealth(state, text) { const b = $("health-badge"); b.dataset.state = state; $("health-text").textContent = text; }
  async function loadHealth() {
    try {
      const h = await (await fetch("/api/health", { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) })).json();
      if (h.limits && Number.isInteger(h.limits.mensajeChars)) input.maxLength = h.limits.mensajeChars;
      document.body.classList.toggle("mock", !!h.mock);
      $("mode-badge").hidden = !h.mock;
      document.title = h.mock ? "[SIMULADO] Agente OC" : "Agente OC";
      if (h.mock) { setHealth("ok", `Servidor listo · ${h.provider}`); showBanner(""); }
      else if (!h.hasApiKey) { setHealth("err", "Sin clave API"); showBanner("El agente no está configurado: falta ANTHROPIC_API_KEY en el servidor."); }
      else setHealth("ok", `Servidor listo · ${h.model}`);
    } catch { setHealth("err", "Sin conexión"); showBanner("No se pudo contactar al servidor."); }
  }
  async function loadSolicitudes(myGen = gen) {
    try { solicitudes = (await (await fetch("/api/solicitudes", { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) })).json()).solicitudes || []; } catch { /* sin solicitudes */ }
    if (myGen !== gen) return;
    if ($("empty")) $("empty").replaceWith(renderEmpty());
    renderQuick(); refreshControls();
  }
  async function init(first = true, myGen = gen) {
    renderQuick();
    const tasks = [loadHealth(), loadSolicitudes(myGen)];
    if (first) tasks.push(restore());
    await Promise.all(tasks);
    if (!first && myGen === gen) { restoring = false; refreshControls(); }
  }
  clearLog();
  init();
})();
