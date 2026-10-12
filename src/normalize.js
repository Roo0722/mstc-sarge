// Turns a chat message into a form the rules can match, undoing the usual tricks.
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };

export function stripAccents(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// "f u c k" / "f.u.c.k" / "f-u-c-k" -> "fuck" (runs of single characters are glued together)
export function joinSpacedLetters(s) {
  return s.replace(/\b(?:[a-z0-9@$][\s.\-_*]+){2,}[a-z0-9@$]\b/g, (m) => m.replace(/[\s.\-_*]+/g, ""));
}

export function collapseRepeats(s, keep = 1) {
  return s.replace(/([a-z])\1+/g, (_, c) => c.repeat(keep));
}

// returns the list of token variants to test: leet-decoded, repeats collapsed to 1 and to 2
export function tokenize(text) {
  let s = stripAccents(String(text)).toLowerCase();
  s = joinSpacedLetters(s);
  const decoded = s.replace(/[01345 7@$!|+]/g, (c) => LEET[c] ?? c);
  const tokens = [];
  for (const src of [s, decoded]) {
    for (const t of src.split(/[^a-z0-9]+/).filter(Boolean)) tokens.push(t);
  }
  const variants = new Set();
  for (const t of tokens) {
    variants.add(t);
    variants.add(collapseRepeats(t, 1));
    variants.add(collapseRepeats(t, 2));
  }
  return [...variants];
}

// Light affix stripping so inflected Filipino/Cebuano forms still reach their root.
const PREFIXES = ["mag", "nag", "pag", "ma", "na", "pa", "ka", "ga", "gi", "mi", "ni", "mo", "i", "um", "in"];
const SUFFIXES = ["han", "hin", "ng", "an", "in", "on", "a", "ay"];
export function stems(token) {
  const out = new Set([token]);
  for (const p of PREFIXES) if (token.startsWith(p) && token.length - p.length >= 3) out.add(token.slice(p.length));
  for (const s of SUFFIXES) if (token.endsWith(s) && token.length - s.length >= 3) out.add(token.slice(0, -s.length));
  for (const t of [...out]) {
    // reduplication: "bubobo" -> "bobo"
    const m = t.match(/^(..)\1/);
    if (m) out.add(t.slice(2));
  }
  return [...out];
}
