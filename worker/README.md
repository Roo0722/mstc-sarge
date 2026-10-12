# worker/ — `mstc-chat`

The members' chat backend: sign-up by invite code, one WebSocket chat room per Durable Object (SQLite, messages deleted
after ~48 h), Sarge moderation on every message, an admin API, and a nightly cleanup cron. Free-plan only.
Design and decisions: [../DESIGN.md](../DESIGN.md).

Status: **works locally end to end** (`npm run smoke` passes against `wrangler dev`). Not deployed. Not yet wired to
the app, the dev panel, or the guided-learning digest.

## Files
- `src/index.js` routes: `/api/signup`, `/api/me`, `/api/ws`, `/api/admin/*`; cron housekeeping
- `src/room.js` the `ChatRoom` Durable Object: messages, moderation, mute/delete/report/attention, cleanup alarm
- `src/auth.js`, `src/protocol.js`, `src/words.js` pure helpers (unit-tested in `test/`)
- `src/push.js` optional staff push hook (needs `PUSH_URL`; adapt to what `mstc-push` expects)
- `schema.sql` D1 tables (users, invites, words, attempts). Chat messages are not in D1.
- `scripts/seed.js` turns `../wordlists/*.txt` into SQL; `scripts/smoke.mjs` end-to-end check

## Run locally
```bash
npm install
echo 'SETUP_KEY=testkey' > .dev.vars        # any value; only for local use
npm run db:init:local
npm run seed && npx wrangler d1 execute mstc-chat-db --local --file=seed.sql
npx wrangler dev                              # http://localhost:8787
SETUP_KEY=testkey npm run smoke               # in a second terminal
```
(`wrangler dev` needs a UUID-shaped `database_id`; for local-only runs put any placeholder UUID there, then restore it.)

## Deploy (free plan)
```bash
npx wrangler d1 create mstc-chat-db           # paste the printed database_id into wrangler.jsonc
npm run db:init
npm run seed && npx wrangler d1 execute mstc-chat-db --remote --file=seed.sql
npx wrangler secret put SETUP_KEY             # long random value; can only create invites
npx wrangler deploy
```
First admin: `POST /api/admin/invites` with header `X-Setup-Key` and `{"role":"admin"}`, sign up with that code in the
app, then use the admin token for everything else. Rotate or delete `SETUP_KEY` afterwards.

## Protocol
WebSocket `/api/ws?room=general`, subprotocols `mstc.v1` and `token.<token>`. Frames are documented at the top of
`src/protocol.js`.
