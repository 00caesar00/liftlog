# Setup — about 15 minutes, once

You need a GitHub account (free). Steps 1–3 are much easier on a computer; everything after
that is phone-only. If you truly have no computer, see the fallback at the bottom.

---

## 1. Create the repo

1. Go to **github.com/new**.
2. Name it something plain: `liftlog`.
3. Set it **Public**. This is required — Claude reads your data over a plain URL and cannot
   send an auth header. The repo will contain sets, reps and dates, plus your DXA baseline.
   If you'd rather not publish the body-composition numbers, delete the `baseline_dxa` and
   `target` blocks from `data/index.json` and paste them into your Claude project
   instructions instead.
4. Create it. Don't add a README.

## 2. Upload the files

On the empty repo page choose **uploading an existing file**, then drag in the contents of the
`liftlog-repo` folder. You should end up with:

```
index.html                 the app shell
app.js                     everything else
sw.js                      offline cache
manifest.webmanifest       makes it installable
icon.png
COACH.md                   coaching rules (the coach reads this)
PROJECT-INSTRUCTIONS.md    paste into your Claude project
SETUP.md  README.md
data/program.json          your 4-day template
data/index.json            digest the coach reads
data/log.json              full history
test.js  test-ui.js  package.json     optional, only if you ever want to run the tests
```

Commit to `main`.

## 3. Turn on GitHub Pages

**Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save.**

After a minute your app is live at:

```
https://<your-username>.github.io/liftlog/
```

## 4. Make a write token

The app writes your sessions back to the repo, so it needs a token scoped to just that repo.

1. **github.com/settings/personal-access-tokens/new**
2. Token name: `liftlog-app`. Expiration: 1 year (set a reminder to rotate it).
3. Repository access → **Only select repositories** → pick `liftlog`.
4. Permissions → Repository permissions → **Contents: Read and write**. Nothing else.
5. Generate, then copy the `github_pat_…` string. You only see it once.

## 5. Install the app on your phone

1. Open `https://<your-username>.github.io/liftlog/` in Safari (iOS) or Chrome (Android).
2. iOS: **Share → Add to Home Screen**. Android: **⋮ → Install app**.
3. Open it from the home screen, go to **Settings**, and fill in:
   - Owner: your GitHub username
   - Repo: `liftlog`
   - Branch: `main`
   - Token: paste the `github_pat_…` string
   - Units: `lb`
4. Tap **Sync now**. The dot in the top-right should go green. If it goes red, the token
   scope is usually the culprit — re-check step 4.

The token lives only in your phone's local storage. It is never committed to the repo.

## 6. Set up the coach

1. In the **Claude mobile app**, create a Project called *Gym Coach*.
2. Open `PROJECT-INSTRUCTIONS.md`, replace `OWNER` and `REPO` with your values, and paste
   the whole thing into the project's **Project instructions**.
3. Start a chat in that project and type **workout**.

---

## Daily loop

| | |
|---|---|
| Morning | Claude project → "workout" → it reads your log and writes today's session |
| Copy | Long-press the fenced plan block → copy |
| Gym | Open LiftLog → paste into "Load a plan" → **Load plan** → **Start session** |
| During | Tap ± to set weight and reps, **Log set**. Rest timer starts itself. |
| End | **Finish & sync**. Green dot means Claude can see it. |

Anything unusual — a tweaky shoulder, four hours of sleep, a 40-minute window — just say it
in chat. Constraints that are permanent go in **Standing notes for the coach** in the app,
which travels with your data.

---

## Phone-only fallback

If you have no computer at all: open github.com in your phone browser, request the desktop
site (iOS: **aA → Request Desktop Website**), and use **Add file → Create new file** for each
file, pasting the contents in and naming `data/program.json` with the slash to create the
folder. It is tedious but it works, and you only do it once.

## Troubleshooting

- **Red sync dot** — token expired or wrong repo scope. Regenerate at step 4.
- **Claude says it can't fetch your data** — check the raw URL loads in your browser:
  `https://raw.githubusercontent.com/<user>/liftlog/main/data/index.json`. It must be public.
- **Claude shows stale numbers** — raw URLs are CDN-cached for a few minutes. Ask it to
  refetch with a different `?cb=` value.
- **Lost your phone / cleared the browser** — reinstall, enter your GitHub details, then
  **Settings → Restore from GitHub**.
