// WebSocket message format between the app and the chat room. Pure functions, unit-tested under plain Node.
//
// App -> server (JSON text frames):
//   {type:"msg", text, cid?}            send a message (cid = client id, echoed back to the sender only)
//   {type:"report", id, reason?}        report message id
//   {type:"attention", note?}           "call attention": alert coaches/admins
//   coach/admin only:
//   {type:"delete", id}                 delete message id
//   {type:"mute", id, minutes?}         mute the author of message id (default 10 min)
//   {type:"unmute", id? | nick?}        lift a mute
//   {type:"reports"}                    list recent reports
//   plain text "ping" is answered with "pong" by the runtime (does not wake the room)
//
// Server -> app: hello, msg, deleted, notice (private), system (public, only on mutes), report, attention, reports
export const MAX_FRAME = 2000;
export const FRAME_TYPES = new Set(["msg", "report", "attention", "delete", "mute", "unmute", "reports"]);

export function parseFrame(data) {
  if (typeof data !== "string" || data.length > MAX_FRAME) return { ok: false, reason: "bad_frame" };
  let f;
  try { f = JSON.parse(data); } catch { return { ok: false, reason: "bad_frame" }; }
  if (!f || typeof f !== "object" || Array.isArray(f) || !FRAME_TYPES.has(f.type)) return { ok: false, reason: "bad_frame" };
  return { ok: true, frame: f };
}

// Removes invisible/control characters that are used to dodge filters, and flattens line breaks.
export function cleanText(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export const toInt = (v, min, max, dflt) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

const REASON_TEXT = [
  ["muted", (r) => mutedText(r.mutedUntil, r.now)],
  ["severe language", () => "Your message wasn't sent. Please keep the chat respectful."],
  ["language", () => "Your message wasn't sent. Please keep the chat respectful."],
  ["mild language", () => "Your message wasn't sent. Please keep the chat respectful."],
  ["phone number", () => "Your message wasn't sent: it looks like a phone number. For safety, don't share personal info."],
  ["link", () => "Your message wasn't sent: links aren't allowed here."],
  ["social handle", () => "Your message wasn't sent: please don't share social media handles."],
  ["address", () => "Your message wasn't sent: please don't share addresses."],
  ["too long", () => "Your message was too long. Please shorten it."],
  ["all caps", () => "Please don't type in ALL CAPS."],
  ["too fast", () => "Slow down a little, you're sending messages too fast."],
  ["repeated message", () => "You already sent that message."],
];

export function mutedText(mutedUntil, now = Date.now()) {
  const mins = Math.max(1, Math.ceil((mutedUntil - now) / 60_000));
  return `You are muted for about ${mins} more minute${mins === 1 ? "" : "s"}. Take a short break.`;
}

// Private notice for the sender after Sarge acted on a message. `r` = moderator result (+ now).
export function noticeFor(r) {
  if (r.action === "censor") return { type: "notice", code: "censored", reasons: r.reasons, text: "Some words were starred out. Please keep the chat friendly." };
  for (const [reason, text] of REASON_TEXT) {
    if (r.reasons.includes(reason)) return { type: "notice", code: reason.replace(/ /g, "_"), reasons: r.reasons, text: text(r) };
  }
  return { type: "notice", code: "blocked", reasons: r.reasons, text: "Your message wasn't sent." };
}

export const muteSystemText = (nick, ms, botName = "Sarge") =>
  `${botName}: ${nick} is muted for ${Math.max(1, Math.round(ms / 60_000))} minutes. Let's keep the chat friendly.`;
