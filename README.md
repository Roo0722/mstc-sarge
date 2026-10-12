# MSTC Sarge

A free, rule-based chat moderator ("Sergeant-at-Arms") for the Malitbog Sepak Takraw Community (MSTC).

It is **not an AI model**. It is a scripted bot with algorithms: quiet by default, it only steps in when a rule is
broken. Over time it gets smarter through word lists and examples that humans review and approve.

This is a standalone project. The MSTConnect app does not use it yet; it will connect later through a separate
chat Worker. See **[DESIGN.md](DESIGN.md)** for the full plan, decisions and open questions.

## What exists today

- `src/`: the moderation engine (plain JavaScript, no dependencies)
  - cleans messages (letter swaps, spacing tricks, repeated letters, simple Filipino/Cebuano affixes)
  - word-list matching with a safe list
  - personal-info rules (phone numbers, links, social handles, addresses), caps, flooding, repeats
  - per-user strikes that **fade over time**, then a short mute
- `wordlists/`: English starter entries; Tagalog and Cebuano lists are empty for coaches to fill in
- `test/`: automated tests (dummy words only)
- `worker/`: the `mstc-chat` Cloudflare Worker (sign-up, chat room, admin API); works locally, not deployed. `dev-panel/` is still a placeholder

## Try it

Requires Node.js 20+.

```bash
npm test
```

## Quick example

```js
import { createModerator } from "./src/engine.js";
import { parseList, parseSet } from "./src/lists.js";

const sarge = createModerator({
  blocked: parseList("darnit,1\nmegabad,3"),
  safe: parseSet("class"),
});

sarge.moderate({ userId: "u1", text: "oh d4rnit I missed" });
// -> { action: "block", reasons: ["mild language"], notify: "sender", ... }
```

Possible results: `allow`, `censor`, `block`, `muted`. `notify` says who is told: `none`, `sender` (private),
`room` (only when a mute starts) or `admins`.
