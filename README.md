# LiftLog

A single-user training log that an LLM can read. No backend, no account, no subscription.

```
   phone (PWA)                    GitHub repo                  Claude project
┌────────────────┐   PUT /contents  ┌──────────────┐  raw URL   ┌───────────────┐
│ log sets/reps  │ ───────────────► │ data/log.json│ ─────────► │ reads digest  │
│ offline-first  │                  │ data/index   │            │ + COACH.md    │
│ localStorage   │ ◄─────────────── │   .json      │            │ writes plan   │
└────────────────┘  restore/program └──────────────┘            └───────┬───────┘
        ▲                                                               │
        └───────────── paste the plan block, or tap a #t= link ─────────┘
```

## Design notes

**Why GitHub as the database.** It is free, versioned (every session is a commit, so nothing
is ever silently lost), has a CORS-enabled write API a browser can call directly, and serves
files at a plain URL that an LLM can fetch without auth. A real database would need a server,
a domain, and a secret Claude cannot send.

**Two files, two readers.** `data/log.json` is the full record for the app. `data/index.json`
is a derived digest — last 10 sessions, per-lift e1RM history, 28-day volume by muscle —
regenerated client-side on every sync. The coach reads only the digest, so context stays small
and constant no matter how many years of history accumulate.

**Local-first.** Every tap writes to `localStorage` immediately. Sync is a separate,
retryable step, so a dead signal in the squat rack cannot cost you a session. A service worker
caches the shell for offline opening.

**Single writer.** Only one phone writes, so the naive read-modify-write against the Contents
API is safe. A stale-SHA 409 refetches and retries once.

**Plain-text plans.** The coach emits a plan as a small text block rather than JSON or base64,
because an LLM writing plain text by hand is reliable and an LLM writing base64 by hand is not.
The parser is deliberately forgiving about bullets, bold and stray whitespace.

## Files

| | |
|---|---|
| `index.html` | shell and styles |
| `app.js` | everything else — state, sync, UI, coaching data digest |
| `sw.js` | offline cache |
| `data/program.json` | the 4-day upper/lower template |
| `data/index.json` | digest the coach reads |
| `data/log.json` | full history |
| `COACH.md` | coaching ruleset — edit this to change how the coach behaves |
| `PROJECT-INSTRUCTIONS.md` | paste into a Claude project |
| `SETUP.md` | one-time setup |

## Changing the coaching

Edit `COACH.md` in GitHub's web editor and commit. The next message you send picks it up.
There is nothing to redeploy.
