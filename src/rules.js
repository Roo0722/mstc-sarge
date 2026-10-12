import { tokenize, stems } from "./normalize.js";
import { collapseRepeats } from "./normalize.js";

// Finds blocked words. `blocked` is Map(word -> severity); `safe` is a Set of words that must never match.
export function findBlockedWords(text, blocked, safe) {
  const hits = [];
  for (const tok of tokenize(text)) {
    if (safe.has(tok)) continue;
    for (const st of stems(tok)) {
      if (safe.has(st)) continue;
      const key = collapseRepeats(st, 1);
      const sev = blocked.get(st) ?? blocked.get(key);
      if (sev) hits.push({ word: key, severity: sev });
    }
  }
  const seen = new Map();
  for (const h of hits) seen.set(h.word, Math.max(h.severity, seen.get(h.word) ?? 0));
  return [...seen].map(([word, severity]) => ({ word, severity }));
}

// Personal-information and spam rules.
export function findPersonalInfo(text) {
  const reasons = [];
  const digits = text.replace(/[\s().\-_/]/g, "");
  if (/(?:\+?63|0)9\d{9}/.test(digits) || /\d{7,}/.test(digits)) reasons.push("phone number");
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|ph|me|ly|gg|io|app)\b/i.test(text)) reasons.push("link");
  if (/(^|\s)@[a-z0-9_.]{3,}/i.test(text)) reasons.push("social handle");
  if (/\b(?:purok|brgy|barangay|street|st\.|blk|block)\b.*\d|\b\d+\s+\w+\s+(?:street|st|ave|road|rd)\b/i.test(text)) reasons.push("address");
  return reasons;
}

export function capsRatio(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 8) return 0;
  return letters.replace(/[^A-Z]/g, "").length / letters.length;
}

export function censor(text, words) {
  let out = text;
  for (const w of words) {
    // replace the word and its simple obfuscations ("f.u.c.k", "fuuuck") with asterisks, keeping the first letter
    const pattern = w.split("").map((c) => `${c}+`).join("[\\s.\\-_*]*");
    out = out.replace(new RegExp(pattern, "gi"), (m) => m[0] + "*".repeat(Math.max(2, m.trim().length - 1)));
  }
  return out;
}
