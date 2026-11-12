import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
if (!scripts.length) throw new Error("No inline application script found in public/index.html");
const output = fileURLToPath(new URL("../.facelesslab-inline-check.js", import.meta.url));
writeFileSync(output, scripts.join("\n;\n"));
console.log("Extracted " + scripts.length + " inline script(s) for syntax validation.");
