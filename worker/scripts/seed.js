// Turns ../wordlists/*.txt into SQL for the D1 `words` table.
//   npm run seed                         (writes seed.sql)
//   wrangler d1 execute mstc-chat-db --local --file=seed.sql      (or --remote)
// Re-running it replaces only rows whose source is 'seed', so words added through the admin API are kept.
import { readFileSync } from "node:fs";
import { parseList, parseSet } from "../../src/lists.js";

const dir = new URL("../../wordlists/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), "utf8");
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = Date.now();

const rows = [];
for (const [file, lang] of [["blocked.en.txt", "en"], ["blocked.tl.txt", "tl"], ["blocked.ceb.txt", "ceb"]]) {
  for (const [word, severity] of parseList(read(file))) rows.push({ word, state: "blocked", lang, severity });
}
for (const word of parseSet(read("safe.txt"))) rows.push({ word, state: "safe", lang: "all", severity: 0 });

const out = ["DELETE FROM words WHERE source = 'seed';"];
for (const r of rows) {
  out.push(`INSERT OR REPLACE INTO words (word, state, lang, severity, source, added_at) VALUES (${q(r.word)}, ${q(r.state)}, ${q(r.lang)}, ${r.severity}, 'seed', ${now});`);
}
console.log(out.join("\n"));
