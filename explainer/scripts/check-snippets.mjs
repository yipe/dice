// Runs every snippet and checks each `expression; // value` line against the real result.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync("snippets/.check", { recursive: true });
let failed = 0;
for (const f of readdirSync("snippets").filter((n) => /^part\d+[a-z]?(-narrow)?\.ts$/.test(n)).sort()) {
  const src = readFileSync(`snippets/${f}`, "utf8").split("\n");
  const out = [...src];
  src.forEach((line, i) => {
    const m = line.match(/^(?!\s*(?:const|let|import|\/\/))(.+?);?\s*\/\/\s*("[^"]*"|-?[\d.]+)/);
    if (!m) return;
    // A chained call (`.mean(); // v`) checks the whole statement, back to its first line (comment lines inside are dropped).
    let start = i;
    if (/^\s*\./.test(line)) while (start > 0 && src[start - 1].trim() !== "" && !/;\s*(\/\/.*)?$/.test(src[start - 1])) start--;
    const expr = [...src.slice(start, i).map((l) => l.replace(/\s*\/\/.*$/, "")), m[1]].join(" ").trim().replace(/;$/, "");
    for (let j = start; j < i; j++) out[j] = "";
    out[i] = `__check(${JSON.stringify(f)}, ${i + 1}, ${expr}, ${m[2]});`;
  });
  const header = `const __check = (f: string, line: number, got: unknown, want: unknown) => {
  const ok = typeof want === "number" ? Math.abs((got as number) - want) <= 0.5 * 10 ** -((String(want).split(".")[1] ?? "").length) + 1e-12 : got === want;
  console.log(ok ? "ok  " : "FAIL", f + ":" + line, JSON.stringify(got), ok ? "" : "expected " + JSON.stringify(want));
  if (!ok) process.exitCode = 1;
};\n`;
  writeFileSync(`snippets/.check/${f}`, header + out.join("\n"));
  try { process.stdout.write(execFileSync(process.execPath, ["--import", "tsx", `snippets/.check/${f}`], { encoding: "utf8" })); }
  catch (e) { failed++; process.stdout.write(e.stdout ?? ""); console.log("FAIL", f, (e.stderr ?? "").split("\n").slice(0, 3).join(" ")); }
}
if (failed) { console.log(failed, "snippet file(s) failed"); process.exit(1); }
