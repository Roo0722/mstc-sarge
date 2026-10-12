// End-to-end check against a running Worker:  npx wrangler dev   then   SETUP_KEY=testkey npm run smoke
// Uses throw-away accounts and dummy words; run it against a local/dev Worker, not production.
const BASE = process.env.BASE || "http://localhost:8787";
const SETUP_KEY = process.env.SETUP_KEY || "testkey";
const WS = BASE.replace(/^http/, "ws");
const run = Date.now().toString(36).slice(-5);
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const api = async (path, { method = "GET", body, token, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

class Client {
  constructor(token, room = "general") {
    this.msgs = [];
    this.ws = new WebSocket(`${WS}/api/ws?room=${room}`, ["mstc.v1", `token.${token}`]);
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("ws error")); });
    this.ws.onmessage = (e) => { if (e.data !== "pong") this.msgs.push(JSON.parse(e.data)); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async until(pred, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = this.msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); }
    return null;
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- bootstrap: first admin via SETUP_KEY ---
const inv = await api("/api/admin/invites", { method: "POST", headers: { "x-setup-key": SETUP_KEY }, body: { role: "admin", count: 1 } });
ok(inv.status === 201, "SETUP_KEY can create an invite");
const bad = await api("/api/admin/users", { headers: { "x-setup-key": SETUP_KEY } });
ok(bad.status === 401 || bad.status === 403, "SETUP_KEY cannot do anything but create invites");
const adm = await api("/api/signup", { method: "POST", body: { nickname: `Boss${run}`, code: inv.body.codes[0] } });
ok(adm.status === 201 && adm.body.token, "admin signs up with invite code");
const A = adm.body.token;
const reuse = await api("/api/signup", { method: "POST", body: { nickname: `Other${run}`, code: inv.body.codes[0] } });
ok(reuse.status === 400, "single-use invite can't be reused");

// --- dummy word list ---
const put = await api("/api/admin/words", { method: "PUT", token: A, body: { lang: "all", state: "blocked", text: "heckwad,2\ndarnit,1" } });
ok(put.status === 200, "admin loads a dummy word list");

// --- members ---
const mi = await api("/api/admin/invites", { method: "POST", token: A, body: { role: "member", count: 2 } });
const m1 = await api("/api/signup", { method: "POST", body: { nickname: `Juan${run}`, code: mi.body.codes[0] } });
const m2 = await api("/api/signup", { method: "POST", body: { nickname: `Maria${run}`, code: mi.body.codes[1] } });
ok(m1.status === 201 && m2.status === 201, "two members sign up");
const dup = await api("/api/signup", { method: "POST", body: { nickname: `J0hn`, code: "MSTC-AAAA-AAAA" } });
ok(dup.status === 400, "bad invite code rejected");
const me = await api("/api/me", { token: m1.body.token });
ok(me.body?.nickname === `Juan${run}` && me.body.role === "member", "/api/me works with token");
ok((await api("/api/me", { token: "nope" })).status === 401, "bad token rejected");
ok((await api("/api/admin/users", { token: m1.body.token })).status === 403, "member can't use admin API");

// --- chat ---
const J = new Client(m1.body.token), M = new Client(m2.body.token), B = new Client(A);
await Promise.all([J.ready, M.ready, B.ready]);
ok(!!(await J.until((m) => m.type === "hello")), "hello received");
J.send({ type: "msg", text: "See you at training!", cid: "c1" });
const got = await M.until((m) => m.type === "msg" && m.text === "See you at training!");
ok(!!got && !got.cid, "message reaches other member (no cid)");
ok(!!(await J.until((m) => m.type === "msg" && m.cid === "c1")), "sender gets own message back with cid");

J.send({ type: "msg", text: "oh darnit" });
const cen = await J.until((m) => m.type === "notice" && m.code === "censored");
const cmsg = await M.until((m) => m.type === "msg" && /d\*+/.test(m.text));
ok(!!cen && !!cmsg, "mild word is starred out; sender gets private notice");

J.send({ type: "msg", text: "call me 0917 123 4567" });
ok(!!(await J.until((m) => m.type === "notice" && m.code === "phone_number")), "phone number blocked privately");
ok(!M.msgs.some((m) => /0917/.test(m.text || "")), "blocked message is not shown to the room");

J.send({ type: "msg", text: "heckwad" });
await sleep(150);
J.send({ type: "msg", text: "h3ckw4d you" });
await sleep(150);
J.send({ type: "msg", text: "hecckwad!!" });
const sys = await M.until((m) => m.type === "system" && /muted/.test(m.text));
ok(!!sys, "repeated bad language ends in a public mute notice");
J.send({ type: "msg", text: "hello again" });
ok(!!(await J.until((m) => m.type === "notice" && m.code === "muted")), "muted member is told, privately");

// --- staff tools ---
const target = M.msgs.find((m) => m.type === "msg" && m.text === "See you at training!");
M.send({ type: "delete", id: target.id });
await sleep(200);
ok(!M.msgs.some((m) => m.type === "deleted"), "member can't delete");
B.send({ type: "delete", id: target.id });
ok(!!(await M.until((m) => m.type === "deleted" && m.id === target.id)), "admin deletes a message");
B.send({ type: "unmute", nick: `Juan${run}` });
ok(!!(await B.until((m) => m.type === "notice" && m.code === "unmuted")), "admin lifts the mute");
J.msgs.length = 0; await sleep(10500); // let the flood window pass
J.send({ type: "msg", text: "thanks coach" });
ok(!!(await J.until((m) => m.type === "msg" && m.text === "thanks coach")), "member can talk again");

M.send({ type: "report", id: J.msgs.find((m) => m.type === "msg").id, reason: "test" });
ok(!!(await M.until((m) => m.type === "notice" && m.code === "reported")), "member reports a message");
ok(!!(await B.until((m) => m.type === "report")), "admin receives the report live");
M.send({ type: "attention", note: "help" });
ok(!!(await B.until((m) => m.type === "attention")), "call attention reaches staff");
B.send({ type: "reports" });
ok(!!(await B.until((m) => m.type === "reports" && m.reports.length >= 1)), "admin lists reports");

// --- room access / bad input ---
const closed = await new Client(m1.body.token, "coaches").ready.then(() => false, () => true);
ok(closed, "member can't open the staff room (or it is disabled)");
M.ws.send("not json");
ok(!!(await M.until((m) => m.code === "bad_frame")), "garbage frame is handled");

// --- ban kicks the member ---
const closedP = new Promise((r) => { M.ws.onclose = (e) => r(e.code); });
const users = await api("/api/admin/users", { token: A });
const maria = users.body.users.find((u) => u.nickname === `Maria${run}`);
await api(`/api/admin/users/${maria.id}`, { method: "PATCH", token: A, body: { banned: true } });
ok((await Promise.race([closedP, sleep(2000).then(() => null)])) === 4003, "ban closes the member's connection");
ok((await api("/api/me", { token: m2.body.token })).status === 401, "banned token no longer works");

[J, M, B].forEach((c) => c.close());
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
