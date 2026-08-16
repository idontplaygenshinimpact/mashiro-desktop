import { readFileSync } from "node:fs";

const w = readFileSync("widget.mjs", "utf8");
for (const f of ["jobs", "zhenti", "oj", "focus", "mail", "rss", "core", "misc", "study", "review", "kb", "practice", "interview"]) {
  const s = readFileSync(`lib/routes/${f}.mjs`, "utf8");
  const re = /route\(\"([^\"]+)\"/g;
  let m;
  const routes = [];
  while ((m = re.exec(s))) routes.push(m[1]);
  console.log(f.padEnd(10), routes.length, routes.join(" "));
}
console.log("--- widget.mjs 残留内联路径:");
const re2 = /url\.pathname === "([^"]+)"/g;
let m2;
const inline = [];
while ((m2 = re2.exec(w))) inline.push(m2[1]);
console.log(inline.join(" "));
