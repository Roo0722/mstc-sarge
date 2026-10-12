import test from "node:test";
import assert from "node:assert/strict";
import { createModerator } from "../src/engine.js";
import { parseList, parseSet } from "../src/lists.js";

// Dummy words only: real lists live in wordlists/ and are filled in by coaches.
const blocked = parseList("darnit,1\nheckwad,2\nmegabad,3\nbadbadbad,2");
const safe = parseSet("class\nheckwadding-is-fine");
const sarge = () => createModerator({ blocked, safe });
const say = (m, text, t, id = "u1", role) => m.moderate({ userId: id, text, now: t, role });

test("normal messages pass untouched and silent", () => {
  const r = say(sarge(), "See you at training tomorrow!", 0);
  assert.equal(r.action, "allow");
  assert.equal(r.notify, "none");
});

test("mild words are censored, not blocked", () => {
  const r = say(sarge(), "oh darnit I missed", 0);
  assert.equal(r.action, "censor");
  assert.match(r.text, /d\*+ I missed/);
});

test("obfuscation is caught: leet, spacing, repeats", () => {
  for (const t of ["h3ckw4d", "h e c k w a d", "heeeckwad", "h.e.c.k.w.a.d", "HECKWAD"]) {
    assert.equal(say(sarge(), t, 0).action, "block", t);
  }
});

test("safe words and innocent look-alikes pass", () => {
  assert.equal(say(sarge(), "great class today", 0).action, "allow");
});

test("Filipino/Cebuano style affixes reach the root", () => {
  assert.equal(say(sarge(), "nagheckwad ka", 0).action, "block");
  assert.equal(say(sarge(), "heckwadan", 0).action, "block");
});

test("phone numbers, links and handles are blocked", () => {
  for (const t of ["call me 0917 123 4567", "visit www.example.com", "dm @someone_ph", "09171234567"]) {
    const r = say(sarge(), t, 0);
    assert.equal(r.action, "block", t);
    assert.equal(r.notify, "sender");
  }
});

test("strikes lead to a public mute, and fade over time", () => {
  const m = sarge();
  assert.equal(say(m, "megabad", 0).notify, "sender"); // weight 2
  const r = say(m, "megabad again", 1000); // weight 2 more -> ~4 >= 3
  assert.equal(r.notify, "room");
  assert.ok(r.mutedUntil > 1000);
  assert.equal(say(m, "hello", 2000).action, "muted");
  // 20 hours later the strikes have faded: back to normal
  const later = 20 * 3600_000;
  assert.equal(say(m, "hello again", later).action, "allow");
  assert.ok(m.strikeScore("u1", later) < 0.5);
});

test("one old slip does not mute a later single offence", () => {
  const m = sarge();
  say(m, "megabad", 0);
  const r = say(m, "megabad", 24 * 3600_000);
  assert.notEqual(r.notify, "room");
});

test("coaches and admins are never filtered", () => {
  assert.equal(say(sarge(), "megabad", 0, "c1", "coach").action, "allow");
});

test("flooding and duplicates are blocked", () => {
  const m = sarge();
  for (let i = 0; i < 5; i++) say(m, `msg ${i}`, i * 100);
  assert.equal(say(m, "msg 6", 600).action, "block");
  const m2 = sarge();
  say(m2, "same text", 0);
  assert.equal(say(m2, "same text", 5000).action, "block");
});

test("a disguised mild word that can't be censored cleanly is blocked, not let through", () => {
  const r = say(sarge(), "d4rn1t", 0);
  assert.equal(r.action, "block");
  assert.equal(r.notify, "sender");
});

test("state survives export/import, so a rebuilt engine keeps strikes and mutes", () => {
  const a = sarge();
  say(a, "heckwad", 0);
  say(a, "megabad", 0); // severe = 2 strikes -> total 3 -> muted
  const saved = JSON.parse(JSON.stringify(a.exportUser("u1")));
  const b = sarge();
  b.importUser("u1", saved);
  assert.equal(say(b, "hello", 2000).action, "muted");
  assert.ok(b.strikeScore("u1", 2000) > 2);
});

test("importUser tolerates garbage", () => {
  const m = sarge();
  m.importUser("u1", { strikes: "x", mutedUntil: "y", recent: [null, 5] });
  assert.equal(say(m, "hello there", 0).action, "allow");
});

test("staff mute and unmute", () => {
  const m = sarge();
  m.mute("u1", 60_000, 0);
  assert.equal(say(m, "hi", 1000).action, "muted");
  m.unmute("u1");
  assert.equal(say(m, "hi again", 2000).action, "allow");
});
