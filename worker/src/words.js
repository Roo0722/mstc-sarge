// Word lists live in D1 (table `words`), not in the Worker code, so they can change without a deploy and so the
// Worker stays small. `watch` words are stored but not enforced.
import { parseList, parseSet, mergeLists } from "../../src/lists.js";

export const LANGS = ["en", "tl", "ceb", "all"];
export const STATES = ["blocked", "watch", "safe"];

// rows: [{word, state, severity}] -> { blocked: Map, safe: Set }
export function buildLists(rows) {
  const blocked = parseList(rows.filter((r) => r.state === "blocked").map((r) => `${r.word},${r.severity}`).join("\n"));
  const safe = parseSet(rows.filter((r) => r.state === "safe").map((r) => r.word).join("\n"));
  return { blocked: mergeLists(blocked), safe };
}

// text (one entry per line, "word" or "word,severity") -> [{word, severity}] ready for the table
export function parseImport(text, state) {
  if (state === "safe") return [...parseSet(text)].map((word) => ({ word, severity: 0 }));
  return [...parseList(text)].map(([word, severity]) => ({ word, severity }));
}

export async function loadLists(db) {
  const { results } = await db.prepare("SELECT word, state, severity FROM words WHERE state IN ('blocked','safe')").all();
  return buildLists(results ?? []);
}

// Replaces every word of (lang, state) with the given entries.
export async function replaceWords(db, { lang, state, entries, source = "admin" }) {
  const now = Date.now();
  const stmts = [db.prepare("DELETE FROM words WHERE lang = ? AND state = ?").bind(lang, state)];
  for (const e of entries) {
    stmts.push(
      db.prepare("INSERT OR REPLACE INTO words (word, state, lang, severity, source, added_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(e.word, state, lang, e.severity, source, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return entries.length;
}
