# LiftLog

A single-user training log that an LLM can read. No backend, no account, no subscription.

```
   phone (PWA)                      GitHub repo                     Claude
┌──────────────────┐  1 commit/sync ┌────────────────────┐  raw URL ┌─────────────────┐
│ log sets/reps    │ ─────────────► │ data/meta.json     │ ───────► │ project chat    │
│ offline-first    │                │ data/sessions/YYYY │          │ reads digest +  │
│ localStorage     │ ◄───────────── │ data/index.json    │          │ COACH.md        │
└───────┬──────────┘    restore     └────────────────────┘          └────────┬────────┘
        │  ▲                                                                 │
        │  └──── copy the reply, tap "Paste plan" ◄──────────────────────────┘
        │
        └──── optional: "Ask the coach" calls the Claude API directly, plan loads itself
```

## Design notes

**GitHub is the database.** Free, versioned (every sync is a commit, nothing is silently lost),
has a CORS-enabled API a browser can call, and serves files at a plain URL that Claude can
fetch without auth. A real database would need a server and a secret Claude cannot send.

**One atomic commit per sync.** The app uses the Git Data API: read the branch head, write
only the files whose contents changed, commit, move the branch. The log and the digest can
never disagree, and edits you make on github.com (to COACH.md, say) are preserved.

**Sessions are split by year** (`data/sessions/2026.json`), and reads use the raw media type,
so there is no 1 MB ceiling on restore no matter how many years accumulate.

**The digest is what the coach reads.** `data/index.json` is regenerated on every sync: per-lift
history keyed by canonical name (26 weeks per session, monthly bests before that), stall and
trend signals, weekly hard sets, scans, the last 4 sessions. It stays roughly the same size
forever.

**Raw logs are never rewritten.** Exercise aliases, warm-up detection and bodyweight loads are
interpreted at read time from `core.js`. Merging two exercise names is an alias you can undo.

**Local-first.** Every tap writes to `localStorage` immediately. Sync runs on its own (30 s after
a change, at most every 4 minutes mid-session, and when you leave the app). A session left open
for 3 hours after its last set closes itself at that last set.

**Versioned data format.** `core.js` has a `MIGRATIONS` table. Each step takes version N and
returns N+1, only adding fields. To change the format later: bump `SCHEMA`, add one step, add a
test. `test.js` runs every migration against the real v1 log.

## Files

| | |
|---|---|
| `index.html` | shell and styles |
| `core.js` | pure logic: catalog, aliases, warm-ups, e1RM, digest, migrations, repo layout |
| `app.js` | UI, GitHub sync, optional Claude API call |
| `sw.js` | offline cache |
| `data/program.json` | the 4-day upper/lower template |
| `data/meta.json` | profile, program, notes, bodyweight, scans, aliases, plan, open session |
| `data/sessions/YYYY.json` | sessions for that year |
| `data/index.json` | digest the coach reads |
| `data/backup/log-v1.json` | frozen copy of the original v1 log, made on the first v2 sync |
| `COACH.md` | coaching ruleset: edit this to change how the coach behaves |
| `PROJECT-INSTRUCTIONS.md` | paste into a Claude project |
| `SETUP.md` | one-time setup and upgrade notes |
| `test.js`, `test-ui.js` | `npm i && npm test` |

## Adding an exercise to the library

Add a line to `CATALOG` in `core.js` (muscles, kind, load type, pattern). Spelling variants go in
`BUILTIN_ALIASES`. Or do it in the app: open the lift under Stats and use **Merge** or **Classify**.

## Changing the coaching

Edit `COACH.md` in GitHub's web editor and commit. The next message you send (or the next
"Ask the coach" tap) picks it up. There is nothing to redeploy.
