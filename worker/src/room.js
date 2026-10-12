// One chat room = one Durable Object (SQLite storage, hibernating WebSockets). It holds the messages (deleted after
// ~48 h), runs the Sarge engine on every message, and broadcasts. Only the Worker (index.js) can reach it.
import { DurableObject } from "cloudflare:workers";
import { createModerator } from "../../src/engine.js";
import { isStaff, nicknameKey } from "./auth.js";
import { parseFrame, cleanText, toInt, noticeFor, muteSystemText } from "./protocol.js";
import { loadLists } from "./words.js";
import { notifyStaff } from "./push.js";

const MAX_SOCKETS = 120; // per room; plenty for a small community
const MAX_PER_USER = 3; // phones/tabs per member
const HISTORY_LIMIT = 100;
const LISTS_TTL_MS = 5 * 60_000;
const STATE_TTL_MS = 48 * 3600_000; // strikes older than this have faded to nothing anyway
const HOUR = 3600_000;
const REPORTS_PER_HOUR = 5;
const ATTENTION_PER_HOUR = 3;

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.lists = null;
    this.listsAt = 0;
    this.botName = env.BOT_NAME || "Sarge";
    this.retentionMs = (Number(env.RETENTION_HOURS) || 48) * HOUR;
    this.reportRetentionMs = (Number(env.REPORT_RETENTION_DAYS) || 7) * 24 * HOUR;
    ctx.blockConcurrencyWhile(async () => {
      for (const q of [
        `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, nick TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
        `CREATE INDEX IF NOT EXISTS messages_at ON messages (at)`,
        `CREATE TABLE IF NOT EXISTS mod_state (user_id TEXT PRIMARY KEY, nick_key TEXT, json TEXT NOT NULL, updated INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, reporter_id TEXT, reporter_nick TEXT, msg_nick TEXT, msg_text TEXT, reason TEXT, at INTEGER, UNIQUE (message_id, reporter_id))`,
        `CREATE TABLE IF NOT EXISTS attention_log (user_id TEXT, at INTEGER)`,
      ]) this.sql.exec(q);
    });
    // "ping" -> "pong" is answered by the runtime without waking the room (free keep-alive)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- requests from the Worker ----------
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/ws": return this.connect(request);
      case "/kick": this.kick(url.searchParams.get("user"), url.searchParams.get("forget") === "1"); return new Response("ok");
      case "/reload": this.lists = null; return new Response("ok");
      case "/sweep": await this.sweep(); return new Response("ok");
      default: return new Response("not found", { status: 404 });
    }
  }

  connect(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    let user;
    try { user = JSON.parse(request.headers.get("X-Mstc-User")); } catch { /* handled below */ }
    if (!user?.id) return new Response("unauthorized", { status: 401 });

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) return new Response("room is full", { status: 503 });
    const mine = this.ctx.getWebSockets(user.id);
    while (mine.length >= MAX_PER_USER) mine.shift().close(4000, "replaced by a newer connection");

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [user.id]);
    server.serializeAttachment({ id: user.id, nick: user.nick, role: user.role });
    server.send(JSON.stringify({
      type: "hello",
      me: { nick: user.nick, role: user.role },
      room: user.room,
      bot: this.botName,
      limits: { maxLength: 500, retentionHours: this.retentionMs / HOUR },
      history: this.history(),
    }));
    const headers = request.headers.get("X-Mstc-Subprotocol") ? { "Sec-WebSocket-Protocol": "mstc.v1" } : {};
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  kick(userId, forget) {
    if (!userId) return;
    for (const ws of this.ctx.getWebSockets(userId)) { try { ws.close(4003, "removed"); } catch { /* already closed */ } }
    if (forget) this.sql.exec("DELETE FROM mod_state WHERE user_id = ?", userId);
  }

  history() {
    const rows = this.sql
      .exec("SELECT id, nick, role, text, at FROM messages WHERE deleted = 0 AND at > ? ORDER BY id DESC LIMIT ?", Date.now() - this.retentionMs, HISTORY_LIMIT)
      .toArray();
    return rows.reverse();
  }

  // ---------- WebSocket events ----------
  async webSocketMessage(ws, data) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    const parsed = parseFrame(data);
    if (!parsed.ok) return this.send(ws, { type: "notice", code: "bad_frame", text: "That message couldn't be read." });
    const f = parsed.frame;
    try {
      switch (f.type) {
        case "msg": return await this.onMessage(ws, me, f);
        case "report": return await this.onReport(ws, me, f);
        case "attention": return await this.onAttention(ws, me, f);
        case "delete": return this.onDelete(ws, me, f);
        case "mute": return this.onMute(ws, me, f);
        case "unmute": return this.onUnmute(ws, me, f);
        case "reports": return this.onReports(ws, me);
      }
    } catch (err) {
      console.error("room error", f.type, err?.message);
      this.send(ws, { type: "notice", code: "error", text: "Something went wrong. Please try again." });
    }
  }

  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* already closed */ } }
  webSocketError(ws) { try { ws.close(1011, "error"); } catch { /* already closed */ } }

  async onMessage(ws, me, f) {
    const text = cleanText(f.text);
    if (!text) return;
    const now = Date.now();
    const lists = await this.getLists(now);
    const mod = createModerator({ blocked: lists.blocked, safe: lists.safe });
    this.loadState(mod, me.id);
    const r = mod.moderate({ userId: me.id, text, now, role: me.role });
    if (me.role === "member") this.saveState(mod, me, now);

    if (r.action === "allow" || r.action === "censor") {
      const out = r.action === "censor" ? r.text : text;
      const id = this.sql.exec("INSERT INTO messages (user_id, nick, role, text, at) VALUES (?, ?, ?, ?, ?) RETURNING id", me.id, me.nick, me.role, out, now).one().id;
      const payload = { type: "msg", id, nick: me.nick, role: me.role, text: out, at: now };
      const mine = typeof f.cid === "string" ? JSON.stringify({ ...payload, cid: f.cid.slice(0, 40) }) : null;
      for (const s of this.ctx.getWebSockets()) {
        const isSender = mine && s.deserializeAttachment()?.id === me.id && s === ws;
        this.send(s, isSender ? mine : payload);
      }
      this.ensureAlarm();
      if (r.action === "censor") this.send(ws, noticeFor({ ...r, now }));
    } else {
      this.send(ws, noticeFor({ ...r, now }));
    }
    if (r.notify === "room" && r.mutedUntil) this.broadcast({ type: "system", text: muteSystemText(me.nick, r.mutedUntil - now, this.botName) });
  }

  onDelete(ws, me, f) {
    if (!isStaff(me.role)) return;
    const id = toInt(f.id, 1, Number.MAX_SAFE_INTEGER, 0);
    // soft delete: the text is gone, the row stays (until cleanup) so staff can still mute its author
    if (this.sql.exec("UPDATE messages SET deleted = 1, text = '' WHERE id = ? AND deleted = 0", id).rowsWritten > 0) {
      this.broadcast({ type: "deleted", id });
    }
  }

  onMute(ws, me, f) {
    if (!isStaff(me.role)) return;
    const row = this.sql.exec("SELECT user_id, nick, role FROM messages WHERE id = ?", toInt(f.id, 1, Number.MAX_SAFE_INTEGER, 0)).toArray()[0];
    if (!row) return this.send(ws, { type: "notice", code: "not_found", text: "That message is gone, so its author can't be found. Ask an admin." });
    if (isStaff(row.role)) return this.send(ws, { type: "notice", code: "not_allowed", text: "Staff can't be muted." });
    const ms = toInt(f.minutes, 1, 24 * 60, 10) * 60_000;
    const lists = { blocked: new Map(), safe: new Set() };
    const mod = createModerator(lists);
    this.loadState(mod, row.user_id);
    mod.mute(row.user_id, ms);
    this.saveState(mod, { id: row.user_id, nick: row.nick }, Date.now());
    this.broadcast({ type: "system", text: muteSystemText(row.nick, ms, this.botName) });
  }

  onUnmute(ws, me, f) {
    if (!isStaff(me.role)) return;
    let userId = null;
    if (f.id != null) userId = this.sql.exec("SELECT user_id FROM messages WHERE id = ?", toInt(f.id, 1, Number.MAX_SAFE_INTEGER, 0)).toArray()[0]?.user_id;
    else if (typeof f.nick === "string") userId = this.sql.exec("SELECT user_id FROM mod_state WHERE nick_key = ?", nicknameKey(f.nick)).toArray()[0]?.user_id;
    if (!userId) return this.send(ws, { type: "notice", code: "not_found", text: "Couldn't find that member." });
    const mod = createModerator({});
    this.loadState(mod, userId);
    mod.unmute(userId);
    this.saveState(mod, { id: userId, nick: null }, Date.now());
    this.send(ws, { type: "notice", code: "unmuted", text: "Mute lifted." });
  }

  async onReport(ws, me, f) {
    const now = Date.now();
    const id = toInt(f.id, 1, Number.MAX_SAFE_INTEGER, 0);
    const msg = this.sql.exec("SELECT id, user_id, nick, text FROM messages WHERE id = ? AND deleted = 0", id).toArray()[0];
    if (!msg || msg.user_id === me.id) return this.send(ws, { type: "notice", code: "not_found", text: "That message can't be reported." });
    const recent = this.sql.exec("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND at > ?", me.id, now - HOUR).one().n;
    if (recent >= REPORTS_PER_HOUR) return this.send(ws, { type: "notice", code: "rate_limited", text: "Too many reports for now. Please try again later." });
    const reason = cleanText(f.reason).slice(0, 200);
    const ins = this.sql.exec(
      "INSERT OR IGNORE INTO reports (message_id, reporter_id, reporter_nick, msg_nick, msg_text, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, me.id, me.nick, msg.nick, msg.text, reason, now);
    this.ensureAlarm();
    this.send(ws, { type: "notice", code: "reported", text: "Thanks. Coaches have been told." });
    if (ins.rowsWritten > 0) {
      this.toStaff({ type: "report", messageId: id, nick: msg.nick, text: msg.text, reason, by: me.nick, at: now });
      await notifyStaff(this.env, { title: "Chat report", body: `${me.nick} reported a message from ${msg.nick}` });
    }
  }

  async onAttention(ws, me, f) {
    const now = Date.now();
    const recent = this.sql.exec("SELECT COUNT(*) AS n FROM attention_log WHERE user_id = ? AND at > ?", me.id, now - HOUR).one().n;
    if (recent >= ATTENTION_PER_HOUR) return this.send(ws, { type: "notice", code: "rate_limited", text: "You've called for attention a few times already. Please wait a bit." });
    const note = cleanText(f.note).slice(0, 140);
    this.sql.exec("INSERT INTO attention_log (user_id, at) VALUES (?, ?)", me.id, now);
    this.ensureAlarm();
    this.toStaff({ type: "attention", nick: me.nick, note, at: now });
    this.send(ws, { type: "notice", code: "attention_sent", text: "Coaches have been alerted." });
    await notifyStaff(this.env, { title: "Attention requested", body: `${me.nick}${note ? `: ${note}` : ""}` });
  }

  onReports(ws, me) {
    if (!isStaff(me.role)) return;
    const reports = this.sql.exec("SELECT id, message_id AS messageId, msg_nick AS nick, msg_text AS text, reason, reporter_nick AS \"by\", at FROM reports ORDER BY id DESC LIMIT 50").toArray();
    this.send(ws, { type: "reports", reports });
  }

  // ---------- state, lists, cleanup ----------
  loadState(mod, userId) {
    const row = this.sql.exec("SELECT json FROM mod_state WHERE user_id = ?", userId).toArray()[0];
    if (row) mod.importUser(userId, JSON.parse(row.json));
  }

  saveState(mod, who, now) {
    this.sql.exec(
      `INSERT INTO mod_state (user_id, nick_key, json, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET json = excluded.json, nick_key = COALESCE(excluded.nick_key, mod_state.nick_key), updated = excluded.updated`,
      who.id, who.nick ? nicknameKey(who.nick) : null, JSON.stringify(mod.exportUser(who.id)), now);
    this.ensureAlarm();
  }

  async getLists(now) {
    if (this.lists && now - this.listsAt < LISTS_TTL_MS) return this.lists;
    try {
      this.lists = await loadLists(this.env.DB);
      this.listsAt = now;
    } catch (err) {
      console.error("word lists unavailable", err?.message);
      this.lists ??= { blocked: new Map(), safe: new Set() }; // keep the last good copy; the other rules still run
      this.listsAt = now - LISTS_TTL_MS + 30_000; // retry in 30 s
    }
    return this.lists;
  }

  ensureAlarm() {
    this.ctx.storage.getAlarm().then((a) => { if (a == null) return this.ctx.storage.setAlarm(Date.now() + HOUR); });
  }

  async alarm() { await this.sweep(); }

  // deletes expired data; keeps an hourly alarm only while something is left to expire
  async sweep() {
    const now = Date.now();
    this.sql.exec("DELETE FROM messages WHERE at < ?", now - this.retentionMs);
    this.sql.exec("DELETE FROM mod_state WHERE updated < ?", now - STATE_TTL_MS);
    this.sql.exec("DELETE FROM reports WHERE at < ?", now - this.reportRetentionMs);
    this.sql.exec("DELETE FROM attention_log WHERE at < ?", now - 2 * HOUR);
    const left = ["messages", "mod_state", "reports", "attention_log"].some((t) => this.sql.exec(`SELECT 1 FROM ${t} LIMIT 1`).toArray().length);
    if (left) await this.ctx.storage.setAlarm(now + HOUR);
  }

  // ---------- sending ----------
  send(ws, obj) { try { ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)); } catch { /* socket is closing */ } }
  broadcast(obj) { const s = JSON.stringify(obj); for (const ws of this.ctx.getWebSockets()) this.send(ws, s); }
  toStaff(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) if (isStaff(ws.deserializeAttachment()?.role)) this.send(ws, s);
  }
}
