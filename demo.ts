// demo.ts - procesa TODOS los casos llamando a las tools directamente y los compara con
// fixtures/reto-03/esperados.json. SIN LLM, SIN red, determinista. Exit 1 si algo no coincide.
// Uso: npm run demo   |   npx tsx demo.ts --matriz   (imprime la matriz de controles en Markdown)
import { ejecutarDemo, matrizMarkdown } from "./src/demo/run";

if (process.argv.includes("--matriz")) {
  console.log(matrizMarkdown());
} else {
  ejecutarDemo()
    .then(({ lines, fallos }) => {
      console.log(lines.join("\n"));
      process.exit(fallos === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error("ERROR inesperado:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
