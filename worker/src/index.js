// mstc-chat: sign-up by invite code, WebSocket entry to the chat room, and a small admin API.
// Chat itself runs inside the ChatRoom Durable Object (room.js).
import { ChatRoom } from "./room.js";
import {
  atLeast, displayCode, inviteProblem, newId, newInviteCode, newToken, nicknameKey, normalizeCode,
  safeEqual, sha256Hex, validateNickname, NICK_MESSAGES, ROLES,
} from "./auth.js";
import { toInt } from "./protocol.js";
import { LANGS, STATES, loadLists, parseImport, replaceWords } from "./words.js";

export { ChatRoom };

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MAX_FAILED_ATTEMPTS = 10; // wrong invite codes per IP per hour
const ROOM_MIN_ROLE = { general: "member", coaches: "coach" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error, message) => json({ error, message }, status);

const enabledRooms = (env) => String(env.ENABLED_ROOMS || "general").split(",").map((s) => s.trim()).filter((r) => r in ROOM_MIN_ROLE);
const roomStub = (env, room) => env.ROOM.get(env.ROOM.idFromName(room));

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("unhandled", err?.stack || err);
      return fail(500, "server_error", "Something went wrong.");
    }
  },

  // Nightly (3 AM Manila): housekeeping. The "guided learning" digest will hook in here later.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await env.DB.prepare("DELETE FROM attempts WHERE reset_at < ?").bind(Date.now()).run();
      for (const room of enabledRooms(env)) await roomStub(env, room).fetch("https://room/sweep");
    })());
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const m = request.method;

  if (pathname === "/api/health") return json({ ok: true, rooms: enabledRooms(env) });
  if (pathname === "/api/signup" && m === "POST") return signup(request, env);
  if (pathname === "/api/me" && m === "GET") {
    const user = await authUser(request, env);
    return user ? json({ id: user.id, nickname: user.nickname, role: user.role }) : fail(401, "unauthorized", "Please sign in again.");
  }
  if (pathname === "/api/ws" && m === "GET") return connect(request, env, url);
  if (pathname.startsWith("/api/admin/")) return admin(request, env, url);
  return fail(404, "not_found", "Not found.");
}

// ---------- auth ----------
function readToken(request, url) {
  const bearer = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") || "");
  if (bearer) return { token: bearer[1], subprotocol: false };
  const protos = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((s) => s.trim());
  const p = protos.find((s) => s.startsWith("token."));
  if (p) return { token: p.slice(6), subprotocol: protos.includes("mstc.v1") };
  const q = url?.searchParams.get("token");
  return q ? { token: q, subprotocol: false } : { token: null, subprotocol: false };
}

async function authUser(request, env, url) {
  const { token } = readToken(request, url ?? new URL(request.url));
  if (!token || token.length > 100) return null;
  return env.DB.prepare("SELECT id, nickname, role FROM users WHERE token_hash = ? AND banned = 0").bind(await sha256Hex(token)).first();
}

async function ipKey(request, env) {
  return "su:" + (await sha256Hex((request.headers.get("CF-Connecting-IP") || "unknown") + (env.IP_SALT || "mstc"))).slice(0, 24);
}

// ---------- sign-up ----------
async function signup(request, env) {
  const now = Date.now();
  const key = await ipKey(request, env);
  const att = await env.DB.prepare("SELECT n, reset_at FROM attempts WHERE key = ?").bind(key).first();
  if (att && att.reset_at > now && att.n >= MAX_FAILED_ATTEMPTS) return fail(429, "too_many_attempts", "Too many wrong codes. Please try again in an hour.");

  const raw = await request.text();
  let body;
  try { body = raw.length <= 1000 ? JSON.parse(raw) : null; } catch { body = null; }
  if (!body || typeof body !== "object") return fail(400, "bad_request", "Send JSON: {nickname, code}.");

  const recordFailure = () => env.DB.prepare(
    `INSERT INTO attempts (key, n, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET n = CASE WHEN reset_at <= ? THEN 1 ELSE n + 1 END,
                                     reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END`,
  ).bind(key, now + HOUR, now, now, now + HOUR).run();

  const code = normalizeCode(body.code);
  const invite = code ? await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first() : null;
  const problem = inviteProblem(invite, now);
  if (problem) {
    await recordFailure();
    return fail(400, `invite_${problem}`, problem === "invalid" || problem === "revoked" ? "That invite code isn't valid." : problem === "expired" ? "That invite code has expired. Ask a coach for a new one." : "That invite code has already been used. Ask a coach for a new one.");
  }

  const lists = await loadLists(env.DB).catch(() => ({ blocked: new Map(), safe: new Set() }));
  const nick = validateNickname(body.nickname, lists, invite.role);
  if (!nick.ok) return fail(400, nick.code, NICK_MESSAGES[nick.code]);
  if (await env.DB.prepare("SELECT 1 FROM users WHERE nickname_key = ?").bind(nick.key).first()) return fail(409, "nickname_taken", NICK_MESSAGES.nickname_taken);

  // claim one use of the invite atomically (two people can't both take the last use)
  const claim = await env.DB.prepare(
    "UPDATE invites SET uses = uses + 1 WHERE id = ? AND revoked = 0 AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)",
  ).bind(invite.id, now).run();
  if (!claim.meta.changes) return fail(400, "invite_used", "That invite code has already been used. Ask a coach for a new one.");

  const token = newToken();
  const user = { id: newId(), nickname: nick.nickname, role: invite.role };
  try {
    await env.DB.prepare("INSERT INTO users (id, nickname, nickname_key, role, token_hash, invite_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(user.id, user.nickname, nick.key, user.role, await sha256Hex(token), invite.id, now).run();
  } catch {
    await env.DB.prepare("UPDATE invites SET uses = MAX(0, uses - 1) WHERE id = ?").bind(invite.id).run(); // give the use back
    return fail(409, "nickname_taken", NICK_MESSAGES.nickname_taken);
  }
  return json({ token, user }, 201);
}

// ---------- WebSocket entry ----------
async function connect(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") return fail(426, "upgrade_required", "Use a WebSocket connection.");
  const room = url.searchParams.get("room") || "general";
  if (!enabledRooms(env).includes(room)) return fail(404, "no_such_room", "No such room.");
  const user = await authUser(request, env, url);
  if (!user) return fail(401, "unauthorized", "Please sign in again.");
  if (!atLeast(user.role, ROOM_MIN_ROLE[room])) return fail(403, "forbidden", "This room is for coaches.");

  // forward only what the room needs; internal headers are set here, never taken from the client
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Sec-WebSocket-Protocol");
  headers.set("X-Mstc-User", JSON.stringify({ id: user.id, nick: user.nickname, role: user.role, room }));
  if (readToken(request, url).subprotocol) headers.set("X-Mstc-Subprotocol", "1"); else headers.delete("X-Mstc-Subprotocol");
  return roomStub(env, room).fetch(new Request("https://room/ws", { method: "GET", headers }));
}

// ---------- admin API (admins only; SETUP_KEY may only create invites, to bootstrap the first admin) ----------
async function admin(request, env, url) {
  const parts = url.pathname.split("/").slice(3); // after /api/admin/
  const m = request.method;
  const user = await authUser(request, env);
  const isAdmin = user && atLeast(user.role, "admin");
  const setupKey = request.headers.get("X-Setup-Key");
  const hasSetupKey = !!(env.SETUP_KEY && setupKey && (await safeEqual(setupKey, env.SETUP_KEY)));
  const creatingInvite = parts[0] === "invites" && m === "POST";
  if (!isAdmin && !(hasSetupKey && creatingInvite)) return fail(isAdmin === null || !user ? 401 : 403, "forbidden", "Admins only.");

  if (parts[0] === "invites") {
    if (m === "POST") {
      const body = await request.json().catch(() => ({}));
      const role = ROLES.includes(body.role) ? body.role : "member";
      const count = toInt(body.count, 1, 50, 1);
      const maxUses = toInt(body.maxUses, 1, 1000, 1);
      const expiresAt = Date.now() + toInt(body.days, 1, 365, 14) * DAY;
      const note = typeof body.note === "string" ? body.note.slice(0, 80) : null;
      const out = [];
      for (let i = 0; i < count; i++) {
        const code = newInviteCode();
        await env.DB.prepare("INSERT INTO invites (id, code, role, max_uses, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(newId(), code, role, maxUses, expiresAt, note, Date.now()).run();
        out.push(displayCode(code));
      }
      return json({ codes: out, role, maxUses, expiresAt }, 201);
    }
    if (m === "GET") {
      const { results } = await env.DB.prepare("SELECT id, code, role, max_uses, uses, expires_at, revoked, note, created_at FROM invites ORDER BY created_at DESC LIMIT 200").all();
      return json({ invites: results.map((r) => ({ ...r, code: displayCode(r.code) })) });
    }
    if (m === "DELETE" && parts[1]) {
      await env.DB.prepare("UPDATE invites SET revoked = 1 WHERE id = ?").bind(parts[1]).run();
      return json({ ok: true });
    }
  }

  if (parts[0] === "users") {
    if (m === "GET" && !parts[1]) {
      const { results } = await env.DB.prepare("SELECT id, nickname, role, banned, created_at FROM users ORDER BY created_at DESC LIMIT 500").all();
      return json({ users: results });
    }
    if (parts[1] && (m === "PATCH" || m === "DELETE")) {
      const id = parts[1];
      if (m === "PATCH") {
        const body = await request.json().catch(() => ({}));
        if (id === user.id && (body.banned || (body.role && body.role !== "admin"))) return fail(400, "self_lockout", "You can't ban or demote yourself.");
        if (body.role !== undefined && !ROLES.includes(body.role)) return fail(400, "bad_role", "Role must be member, coach or admin.");
        if (body.role) await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.role, id).run();
        if (body.banned !== undefined) await env.DB.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(body.banned ? 1 : 0, id).run();
        await kickEverywhere(env, id, false);
      } else {
        // reset (lost phone): the person signs up again with a new invite code
        if (id === user.id) return fail(400, "self_lockout", "You can't remove yourself.");
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        await kickEverywhere(env, id, true);
      }
      return json({ ok: true });
    }
  }

  if (parts[0] === "words") {
    if (m === "GET") {
      const state = url.searchParams.get("state");
      const sql = "SELECT word, state, lang, severity, source FROM words" + (STATES.includes(state) ? " WHERE state = ?" : "") + " ORDER BY lang, word LIMIT 5000";
      const q = env.DB.prepare(sql);
      const { results } = await (STATES.includes(state) ? q.bind(state) : q).all();
      return json({ words: results });
    }
    if (m === "PUT") {
      const body = await request.json().catch(() => ({}));
      if (!LANGS.includes(body.lang) || !STATES.includes(body.state) || typeof body.text !== "string") {
        return fail(400, "bad_request", "Send {lang: en|tl|ceb|all, state: blocked|watch|safe, text}.");
      }
      const entries = parseImport(body.text, body.state);
      const n = await replaceWords(env.DB, { lang: body.lang, state: body.state, entries });
      for (const room of enabledRooms(env)) await roomStub(env, room).fetch("https://room/reload");
      return json({ ok: true, words: n });
    }
  }
  return fail(404, "not_found", "Not found.");
}

async function kickEverywhere(env, userId, forget) {
  for (const room of enabledRooms(env)) {
    await roomStub(env, room).fetch(`https://room/kick?user=${encodeURIComponent(userId)}${forget ? "&forget=1" : ""}`);
  }
}
