// Identity helpers: tokens, invite codes, nicknames. Pure functions (no Cloudflare APIs except Web Crypto), so they
// are unit-tested under plain Node.
import { stripAccents, collapseRepeats, LEET } from "../../src/normalize.js";
import { findBlockedWords, findPersonalInfo } from "../../src/rules.js";

export const ROLES = ["member", "coach", "admin"];
export const roleRank = (r) => Math.max(0, ROLES.indexOf(r));
export const atLeast = (role, min) => roleRank(role) >= roleRank(min);
export const isStaff = (role) => atLeast(role, "coach");

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const newId = () => b64url(crypto.getRandomValues(new Uint8Array(9)));

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// compares two strings without leaking where they differ
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---- invite codes: "MSTC-XXXX-XXXX", no look-alike characters (0/O, 1/I/L) ----
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 characters

export function newInviteCode() {
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < 8) out += CODE_CHARS[b % 31]; // 248 = 31 * 8: no modulo bias
    }
  }
  return out;
}
export const displayCode = (code) => `MSTC-${code.slice(0, 4)}-${code.slice(4)}`;

// accepts "mstc-abcd-efgh", "ABCD EFGH", "abcdefgh"
export function normalizeCode(input) {
  let s = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 12 && s.startsWith("MSTC")) s = s.slice(4);
  return s.length === 8 ? s : "";
}

// null when the invite can be used, otherwise why not
export function inviteProblem(inv, now) {
  if (!inv) return "invalid";
  if (inv.revoked) return "revoked";
  if (inv.expires_at && inv.expires_at <= now) return "expired";
  if (inv.uses >= inv.max_uses) return "used";
  return null;
}

// ---- nicknames ----
const RESERVED_EXACT = new Set(["mstc", "bot", "deleted"]);
const RESERVED_PREFIX = ["sarge", "admin", "coach", "moderator", "system", "staff"];

// Look-alike-proof key: "J0hn", "john" and "J o h n" all map to "john" (and so cannot both be registered).
export function nicknameKey(nick) {
  let s = stripAccents(String(nick).toLowerCase()).replace(/[01345 7@$!|+]/g, (c) => LEET[c] ?? c);
  s = s.replace(/[^a-z0-9]/g, "");
  return collapseRepeats(s, 1);
}

export const NICK_MESSAGES = {
  nickname_invalid: "Nicknames are 3-16 characters: letters, numbers, spaces, dots, dashes or underscores.",
  nickname_reserved: "That nickname is reserved. Please pick another.",
  nickname_not_allowed: "That nickname isn't allowed. Please pick another.",
  nickname_taken: "That nickname is already taken. Please pick another.",
};

// lists = { blocked: Map, safe: Set }. role = the role the invite grants (staff may use staff-like names).
export function validateNickname(raw, lists, role = "member") {
  const nickname = String(raw ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  const len = [...nickname].length;
  if (len < 3 || len > 16 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*[\p{L}\p{N}]$/u.test(nickname)) {
    return { ok: false, code: "nickname_invalid" };
  }
  const key = nicknameKey(nickname);
  if (key.length < 3) return { ok: false, code: "nickname_invalid" };
  if (key === "sarge" || key.startsWith("sarge") || RESERVED_EXACT.has(key)) return { ok: false, code: "nickname_reserved" };
  if (!isStaff(role) && RESERVED_PREFIX.some((p) => key.startsWith(p))) return { ok: false, code: "nickname_reserved" };
  if (findBlockedWords(nickname, lists.blocked, lists.safe).length || findPersonalInfo(nickname).length) {
    return { ok: false, code: "nickname_not_allowed" };
  }
  return { ok: true, nickname, key };
}
