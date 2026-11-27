// Formato es-CO SIN perdida de precision (miles con punto, decimales con coma). Lo usa el servidor para que la tarjeta de
// aprobacion muestre exactamente lo que se grabara (cantidades hasta 3 decimales, precios y montos hasta 2).
import { MAX_DEC_CANTIDAD } from "./dinero";

function miles(x: number, dec: number, recortar: boolean): string {
  let [int = "0", d = ""] = Math.abs(x).toFixed(dec).split(".");
  if (recortar) d = d.replace(/0+$/, "");
  else if (/^0*$/.test(d)) d = ""; // entero: sin decimales; si no, siempre completos (12,50)
  return (x < 0 ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (d ? "," + d : "");
}
/** Cantidad: hasta 3 decimales, sin ceros sobrantes (0,004 / 2,5 / 10). */
export const fmtCantidad = (n: number): string => miles(n, MAX_DEC_CANTIDAD, true);
/** Precio o monto: entero sin decimales; si no, 2 decimales completos. */
export const fmtMonto = (n: number): string => miles(n, 2, false);
