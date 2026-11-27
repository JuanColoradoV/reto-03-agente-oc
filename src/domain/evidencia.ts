// Evidencia de aprobación (HU-4): out/<caso>/aprobacion.txt (P0) y aprobacion.pdf (P1, pdf-lib, compatible con Workers).
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { OutStore } from "../out/store";
import type { Aprobacion } from "./tipos";
import { sha256Hex } from "./util";

/** Contenido que se firma: encabezados + cuerpo. El sha256 se calcula sobre ESTE texto. */
export function contenidoEvidencia(a: Aprobacion): string {
  return `De: ${a.de}\nPara: ${a.para}\nFecha: ${a.fecha}\nAsunto: ${a.asunto}\n\n${a.texto}\n`;
}

export const hashEvidencia = (a: Aprobacion): Promise<string> => sha256Hex(contenidoEvidencia(a));

/** Divide en líneas de a lo sumo `max` caracteres (sin cortar palabras). */
function ajustar(texto: string, max: number): string[] {
  const out: string[] = [];
  for (const linea of texto.split("\n")) {
    let actual = "";
    for (const palabra of linea.split(" ")) {
      if ((actual + " " + palabra).trim().length > max) {
        out.push(actual);
        actual = palabra;
      } else actual = (actual + " " + palabra).trim();
    }
    out.push(actual);
  }
  return out;
}

/** WinAnsi (Helvetica estándar) no cubre todos los caracteres: se reemplaza lo que no cabe. */
const winAnsi = (s: string): string => s.replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");

async function generarPdf(a: Aprobacion, sha256: string, fecha: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(fecha);
  pdf.setModificationDate(fecha);
  pdf.setProducer("reto-03");
  const fuente = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  let pagina = pdf.addPage([595, 842]);
  let y = 800;
  const linea = (t: string, bold = false) => {
    if (y < 60) {
      pagina = pdf.addPage([595, 842]);
      y = 800;
    }
    pagina.drawText(winAnsi(t), { x: 50, y, size: 10, font: bold ? negrita : fuente });
    y -= 14;
  };
  linea("Evidencia de aprobacion de compra", true);
  y -= 6;
  for (const [k, v] of [["De", a.de], ["Para", a.para], ["Fecha", a.fecha], ["Asunto", a.asunto]] as const) for (const l of ajustar(`${k}: ${v}`, 90)) linea(l, true);
  y -= 8;
  for (const l of ajustar(a.texto, 95)) linea(l);
  y -= 8;
  for (const l of ajustar(`sha256 del contenido: ${sha256}`, 80)) linea(l);
  return pdf.save();
}

export interface EvidenciaGenerada {
  ruta: string;
  ruta_pdf: string;
  sha256: string;
}

export async function generarEvidencia(store: OutStore, caso: string, a: Aprobacion, fecha: Date): Promise<EvidenciaGenerada> {
  const contenido = contenidoEvidencia(a);
  const sha256 = await sha256Hex(contenido);
  const base = `${caso}/aprobacion`;
  await store.escribir(`${base}.txt`, `${contenido}\n---\nsha256: ${sha256}\n`);
  await store.escribir(`${base}.pdf`, await generarPdf(a, sha256, fecha));
  return { ruta: `out/${base}.txt`, ruta_pdf: `out/${base}.pdf`, sha256 };
}
