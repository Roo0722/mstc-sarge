# Word lists

Plain text, one entry per line: `word` or `word,severity`.

| Severity | Meaning | Action |
|---|---|---|
| 1 | mild | censored as `f***` |
| 2 | medium (default) | message blocked, private notice |
| 3 | severe | message blocked, counts double toward a mute |

Lines starting with `#` are comments. Letter swaps (`@`→a, `3`→e), repeated letters, spaced-out letters and
simple Filipino/Cebuano prefixes/suffixes are handled by the engine, so list **root words only**.

- `blocked.en.txt`, `blocked.tl.txt` (Tagalog), `blocked.ceb.txt` (Cebuano): words to act on.
- `safe.txt`: words that must never match (fixes false alarms such as an innocent word containing a bad one).

The Tagalog and Cebuano lists start empty on purpose: they should be written by coaches and members who know the
local language and slang. Review them together before turning the bot on.
