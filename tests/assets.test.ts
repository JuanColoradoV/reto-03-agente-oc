import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const headers = readFileSync(join(import.meta.dirname, "..", "public", "_headers"), "utf8");

test("cache-busting: la pagina, app.js y styles.css se revalidan siempre (Cache-Control: no-cache en public/_headers)", () => {
  for (const ruta of ["/", "/index.html", "/app.js", "/styles.css"]) {
    const bloque = new RegExp(`^${ruta.replace(".", "\\.")}\\n\\s+Cache-Control: no-cache`, "m");
    assert.match(headers, bloque, ruta);
  }
});

test("las cabeceras de seguridad de los assets siguen en la regla /*", () => {
  assert.match(headers, /^\/\*\n[\s\S]*Content-Security-Policy:/m);
});
