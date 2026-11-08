// Bouwt dist/kring-test.html: één zelfstandig bestand (testversie) met parser en testdata ingebakken.
// Het resultaat bevat persoonlijke data: niet publiceren of committen (dist/ staat in .gitignore).
// Gebruik: node build.js
const fs = require("fs"), path = require("path");
const r = p => fs.readFileSync(path.join(__dirname, p), "utf8");
const html = r("index.html");
let app = html.split("<!--APP-START-->")[1].split("<!--APP-END-->")[0];
// Persoonlijke testdata staat buiten de repo (map ../kring-prive, niet publiek)
const prive = process.env.KRING_PRIVE || path.join(__dirname, "..", "kring-prive");
const seed = JSON.parse(fs.readFileSync(path.join(prive, "kring-seed.json"), "utf8"));
const inline = s => s.replace(/<\/script/gi, "<\\/script");
app = app.replace(/<script src="(src\/[\w-]+\.js)"><\/script>/g, (_, f) => `<script>${inline(r(f))}</script>`);
app = app.replace("<script>\n\"use strict\";\n/* ================= Constanten", () =>
  `<script>window.KRING_SEED=${inline(JSON.stringify(seed))};</script>\n<script>\n"use strict";\n/* ================= Constanten`);
fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist/kring-test.html"), app.trim() + "\n");
console.log("dist/kring-test.html", (Buffer.byteLength(app) / 1024).toFixed(0) + " kB");
