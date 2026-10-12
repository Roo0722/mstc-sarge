# Design notes: MSTC chat and Sarge

Status: brainstorming. Nothing here is live. Decisions are marked **Decided**; open items are in the last section.

## Goal

A free, safe chat for MSTC members (some are minors), kept small and moderated, with no recurring cost.

## Decided

- **Free only.** Cloudflare free plan; no paid services.
- **Separate from the website.** Only admins touch the website. Sign-up happens **inside the app**, through a
  separate chat Worker (`mstc-chat`), like the existing `mstc-push`.
- **Identity.** Nickname + invite code from admins; the Worker issues a secret token kept on the phone. No email or
  password. Roles: member, coach, admin. A lost phone means signing up again or an admin reset.
- **History.** Messages are readable for about 1–2 days, then deleted.
- **Sarge is a bot with algorithms, not an AI model.** Quiet by default: normal messages pass untouched. Warnings
  and block notices are private to the sender. The room only sees the bot when someone is muted.
- **Filter.** Cleans the message, checks word lists (English, Tagalog, Cebuano, with slang) and rules (personal info,
  links, caps, flooding, repeats), censors or blocks, and counts strikes that **fade over time** (half-life ~6 h).
- **Dictionary.** A Filipino and a Cebuano dictionary (with slang) will help match word forms and cut false alarms.
  It lives in the database, not in the Worker code. Source and licence still to be settled; slang comes mainly from
  coaches and members.
- **Nightly learning ("guided learning").** A scheduled job digests the day's messages (names removed), then raw
  messages are deleted. It does not change the bot's rules by itself:
  - words already blocked are discarded
  - new candidates go to a **watch** state (counted, not enforced)
  - anything suspicious (see below) is flagged to the devs with context and waits for a decision
  - results are reviewed in the **dev panel**, and every lesson can be undone
- **Three word states:** blocked (enforced), watch (observed only), safe (never flagged, set by devs only).
- **Poisoning defences.** A term needs several different users before it is proposed; bursts from one person or a
  small group are flagged; nobody but a dev can add to the safe list; messages from new accounts count for less;
  a cap on proposals per night; the dev panel has its own login.
- **Workers AI is optional and later.** It can suggest candidates or give a second opinion on gray cases. It does
  not learn from chats; "learning" is the reviewed word list and examples. It is weakest in Cebuano/Tagalog.

## Planned architecture

```
App (members) ──WebSocket──> mstc-chat Worker ──> Durable Object (one per room, SQLite storage)
                                   │                    ├─ messages (deleted after ~48 h)
                                   │                    └─ Sarge engine (this repo's src/)
                                   ├─ D1: users, roles, strikes, word lists, watch/safe, learned log
                                   ├─ cron (~3 AM Manila): nightly digest -> proposals
                                   └─ FCM push (existing Firebase): new messages, "call attention"
Dev panel (separate login) ──> reads proposals / flags, approves, undoes
```

Durable Objects with WebSocket hibernation keep real-time chat cheap: an incoming WebSocket message counts as 1/20
of a request, and outgoing messages are free. Polling from many phones would use far more of the daily budget.

## Cloudflare free-plan numbers (checked on 2026-10-11; recheck before building)

- Workers: 100,000 requests/day, 10 ms CPU per request. The request limit is per account, shared with the website
  and the push Worker. Set a usage alert.
- Durable Objects (SQLite-backed only on free): 100,000 requests/day, 13,000 GB-s/day, 5 GB storage; limits reset
  at 00:00 UTC. https://developers.cloudflare.com/durable-objects/platform/pricing
- Workers AI: 10,000 neurons/day free; `@cf/meta/llama-guard-3-8b` exists (rough estimate: ~700 checks/day).
  https://developers.cloudflare.com/workers-ai/platform/pricing/
- Free-plan Worker code size limit is small (believed ~3 MB): keep dictionaries in the database.

## Safeguards (minors)

Group rooms only, **no private messages** between members at first. Report button, admin/coach delete and mute,
rate limits, no images at first. Store only nickname, role and token. Tell members in the sign-up screen that
messages are scanned. Check retention and consent with someone who knows the Philippine Data Privacy Act (RA 10173).
Only reviewed, name-free snippets may be kept longer than 48 hours, and only with that consent.

## "Call attention"

A button that sends a push to coaches/admins with a short note, limited to a few uses per hour.

## Open questions

1. Bot name and tone (strict/friendly)?
2. Strike ladder numbers (currently: weighted strikes >= 3 -> 10 min mute; >= 5 -> 1 h)?
3. Starting Tagalog and Cebuano word lists, and who writes them?
4. Mild swearing: censor (`f***`) or block? (Currently censor.)
5. One invite code or one per member?
6. Nicknames, or first name + nickname (minors)?
7. Rooms: one General room, or also Coaches and per-group rooms?
8. First admins/moderators? How many approvals does a learned word need (one or two devs)?
9. Dictionary source with a licence that allows reuse?

## Not planned yet

Leaderboards and competition between accounts (needs coach-agreed, hard-to-cheat scoring), membership/roster data
(website database first), offline cache and other app features. Ask MSTC (https://mstc-ask.pages.dev/) may be
linked from the app separately.
