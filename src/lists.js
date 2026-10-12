// Word lists are plain text: one entry per line, "word" or "word,severity" (1 mild, 2 medium, 3 severe).
// Lines starting with # are comments. Default severity is 2.
import { collapseRepeats, stripAccents } from "./normalize.js";

export function parseList(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [w, sev] = line.split(",").map((x) => x.trim());
    const word = collapseRepeats(stripAccents(w.toLowerCase()), 1);
    out.set(word, Math.min(3, Math.max(1, Number(sev) || 2)));
  }
  return out;
}

export function mergeLists(...lists) {
  const out = new Map();
  for (const l of lists) for (const [w, s] of l) out.set(w, Math.max(s, out.get(w) ?? 0));
  return out;
}

export function parseSet(text) {
  return new Set(
    String(text).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#")),
  );
}
