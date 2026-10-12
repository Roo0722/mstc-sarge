// Sarge: quiet by default. Normal messages pass untouched. A message that breaks a rule is censored or blocked
// (privately, to the sender), strikes are counted with exponential fading, and only a mute is ever public.
import { findBlockedWords, findPersonalInfo, capsRatio, censor } from "./rules.js";

export const DEFAULTS = {
  strikeHalfLifeMs: 6 * 3600_000, // a strike counts half as much after 6 hours
  muteAtStrikes: 3, // weighted strike total that triggers a mute
  muteMs: 10 * 60_000,
  repeatMuteMs: 60 * 60_000,
  repeatMuteAtStrikes: 5,
  floodMessages: 5, // more than this many messages...
  floodWindowMs: 10_000, // ...inside this window is flooding
  duplicateWindowMs: 30_000,
  maxLength: 500,
  capsLimit: 0.8,
  mildSeverityAction: "censor", // "censor" or "block"
};

export function createModerator({ blocked = new Map(), safe = new Set(), config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const users = new Map(); // userId -> { strikes: [{t, w}], mutedUntil, recent: [{t, text}] }
  const state = (id) => users.get(id) ?? users.set(id, { strikes: [], mutedUntil: 0, recent: [] }).get(id);

  const strikeScore = (u, now) =>
    u.strikes.reduce((sum, s) => sum + s.w * Math.pow(0.5, (now - s.t) / cfg.strikeHalfLifeMs), 0);

  function addStrike(u, w, now) {
    u.strikes.push({ t: now, w });
    u.strikes = u.strikes.filter((s) => now - s.t < cfg.strikeHalfLifeMs * 8); // forget very old ones
    const score = strikeScore(u, now);
    if (score >= cfg.repeatMuteAtStrikes) return { muteMs: cfg.repeatMuteMs, score };
    if (score >= cfg.muteAtStrikes) return { muteMs: cfg.muteMs, score };
    return { muteMs: 0, score };
  }

  // returns { action: "allow"|"censor"|"block"|"muted", text?, reasons, notify: "none"|"sender"|"room"|"admins", strikeScore }
  function moderate({ userId, text, now = Date.now(), role = "member" }) {
    const u = state(userId);
    const privileged = role === "coach" || role === "admin";

    if (u.mutedUntil > now) {
      return { action: "muted", reasons: ["muted"], notify: "sender", mutedUntil: u.mutedUntil, strikeScore: strikeScore(u, now) };
    }
    if (privileged) return { action: "allow", text, reasons: [], notify: "none", strikeScore: 0 };

    const reasons = [];
    let weight = 0;
    let out = text;
    let action = "allow";

    const words = findBlockedWords(text, blocked, safe);
    const worst = Math.max(0, ...words.map((w) => w.severity));
    if (worst === 1 && cfg.mildSeverityAction === "censor") {
      out = censor(text, words.map((w) => w.word));
      // if the disguised word can't be starred out cleanly, don't let it through: block it (no strike for mild words)
      action = out === text ? "block" : "censor";
      reasons.push("mild language");
    } else if (worst >= 1) {
      action = "block";
      weight += worst >= 3 ? 2 : 1;
      reasons.push(worst >= 3 ? "severe language" : "language");
    }

    const info = findPersonalInfo(text);
    if (info.length) {
      action = "block";
      weight += 1;
      reasons.push(...info);
    }

    if (text.length > cfg.maxLength) { action = "block"; reasons.push("too long"); }
    if (capsRatio(text) > cfg.capsLimit) { action = "block"; reasons.push("all caps"); }

    u.recent = u.recent.filter((r) => now - r.t < cfg.floodWindowMs || now - r.t < cfg.duplicateWindowMs);
    const norm = text.trim().toLowerCase();
    if (u.recent.filter((r) => now - r.t < cfg.floodWindowMs).length >= cfg.floodMessages) { action = "block"; reasons.push("too fast"); }
    if (u.recent.some((r) => r.text === norm && now - r.t < cfg.duplicateWindowMs)) { action = "block"; reasons.push("repeated message"); }
    u.recent.push({ t: now, text: norm });

    let notify = action === "allow" ? "none" : "sender";
    let muteInfo = { muteMs: 0 };
    if (weight > 0) {
      muteInfo = addStrike(u, weight, now);
      if (muteInfo.muteMs) {
        u.mutedUntil = now + muteInfo.muteMs;
        notify = "room"; // the only time the bot speaks publicly
        action = "block";
        reasons.push("muted");
      }
    }
    return { action, text: action === "censor" ? out : action === "allow" ? text : undefined, reasons, notify, mutedUntil: u.mutedUntil || undefined, strikeScore: strikeScore(u, now) };
  }

  return { moderate, strikeScore: (id, now = Date.now()) => strikeScore(state(id), now), unmute: (id) => { state(id).mutedUntil = 0; } };
}
