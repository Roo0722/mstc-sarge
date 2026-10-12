import test from "node:test";
import assert from "node:assert/strict";
import { parseList, parseSet } from "../../src/lists.js";
import { normalizeCode, displayCode, newInviteCode, inviteProblem, validateNickname, nicknameKey, isStaff, atLeast } from "../src/auth.js";
import { parseFrame, cleanText, noticeFor, mutedText, toInt } from "../src/protocol.js";
import { buildLists, parseImport } from "../src/words.js";

const lists = { blocked: parseList("heckwad,2"), safe: parseSet("") };

test("invite codes: format, normalising, no look-alikes", () => {
  for (let i = 0; i < 200; i++) assert.match(newInviteCode(), /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(normalizeCode("mstc-abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizeCode("abcd efgh"), "ABCDEFGH");
  assert.equal(normalizeCode("short"), "");
  assert.equal(displayCode("ABCDEFGH"), "MSTC-ABCD-EFGH");
});

test("invite problems", () => {
  const ok = { revoked: 0, uses: 0, max_uses: 1, expires_at: 2000 };
  assert.equal(inviteProblem(ok, 1000), null);
  assert.equal(inviteProblem(null, 1000), "invalid");
  assert.equal(inviteProblem({ ...ok, revoked: 1 }, 1000), "revoked");
  assert.equal(inviteProblem(ok, 3000), "expired");
  assert.equal(inviteProblem({ ...ok, uses: 1 }, 1000), "used");
});

test("nicknames", () => {
  assert.equal(validateNickname("Juan", lists).ok, true);
  assert.equal(validateNickname("ab", lists).code, "nickname_invalid");
  assert.equal(validateNickname("Sarge", lists).code, "nickname_reserved");
  assert.equal(validateNickname("S4rge2", lists).code, "nickname_reserved");
  assert.equal(validateNickname("Coach Ben", lists).code, "nickname_reserved");
  assert.equal(validateNickname("Coach Ben", lists, "coach").ok, true);
  assert.equal(validateNickname("heckwad", lists).code, "nickname_not_allowed");
  assert.equal(validateNickname("call 09171234567", lists).ok, false);
  assert.equal(nicknameKey("J0hn"), nicknameKey("john"));
  assert.equal(nicknameKey("J o h n"), nicknameKey("john"));
});

test("roles", () => {
  assert.ok(isStaff("coach") && isStaff("admin") && !isStaff("member"));
  assert.ok(atLeast("admin", "coach") && !atLeast("member", "coach"));
});

test("frames", () => {
  assert.equal(parseFrame("nope").ok, false);
  assert.equal(parseFrame("[]").ok, false);
  assert.equal(parseFrame('{"type":"hack"}').ok, false);
  assert.equal(parseFrame("x".repeat(2001)).ok, false);
  assert.equal(parseFrame('{"type":"msg","text":"hi"}').ok, true);
});

test("cleanText strips control and invisible characters", () => {
  assert.equal(cleanText("a​b\nc\u0000d  e"), "ab c d e");
  assert.equal(cleanText(null), "");
});

test("notices and helpers", () => {
  assert.match(noticeFor({ action: "block", reasons: ["link"] }).text, /links/);
  assert.equal(noticeFor({ action: "censor", reasons: ["mild language"] }).code, "censored");
  assert.match(mutedText(61_000, 0), /2 more minutes/);
  assert.equal(toInt("abc", 1, 5, 3), 3);
  assert.equal(toInt(99, 1, 5, 3), 5);
});

test("word list build/import", () => {
  const l = buildLists([
    { word: "heckwad", state: "blocked", severity: 3 },
    { word: "class", state: "safe", severity: 0 },
    { word: "maybe", state: "watch", severity: 2 },
  ]);
  assert.equal(l.blocked.get("heckwad"), 3);
  assert.ok(l.safe.has("class"));
  assert.equal(l.blocked.has("maybe"), false);
  assert.deepEqual(parseImport("a,1\n#c\nb", "blocked"), [{ word: "a", severity: 1 }, { word: "b", severity: 2 }]);
});
