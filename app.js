/* LiftLog app: persistence, GitHub sync, coach API, UI. Pure logic lives in core.js. */
'use strict';
const C = (typeof window !== 'undefined' && window.LiftCore) || require('./core.js');
const { MUSCLES, MUSCLE_LABEL, KIND_LABEL, LOAD_NOTE, e1rm, parseTarget, canon, exInfo, readEntry,
        liftSeries, liftSummary, sessionVolume, hardSetsByMuscle, buildDigest, today, daysAgo, addDays,
        byDateAsc, byDateDesc, hasRir, round1, clone } = C;

/* ---------------- persistence ----------------
   v2 lives under a new key. The v1 key is left untouched as a local safety copy.       */
const KEY = 'liftlog.db';
const KEY_V1 = 'liftlog.db.v1';
let db = load();
/* UI state that has to survive a lock/unlock, or iOS quietly reloading the app: half-entered sets,
   the rest timer, collapsed cards, where you were. Stays on the phone, never synced. */
const KEY_UI = 'liftlog.ui';
const UI_BLANK = () => ({ drafts: {}, rest: null, open: {}, where: null });
let uiState = loadUi();
function loadUi() { try { return Object.assign(UI_BLANK(), JSON.parse(localStorage.getItem(KEY_UI) || '{}')); } catch (e) { return UI_BLANK(); } }
function saveUi() { try { localStorage.setItem(KEY_UI, JSON.stringify(uiState)); } catch (e) {} }
function load() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(KEY_V1);
    if (!raw) return C.migrate(C.DEFAULT_DB);
    return C.migrate(JSON.parse(raw));
  } catch (e) { console.error(e); return C.migrate(C.DEFAULT_DB); }
}
function save(markDirty) {
  if (markDirty) { db.dirty = true; db.changedAt = new Date().toISOString(); }
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Could not save locally: ' + e.message); }
  paintSyncBadge();
  if (markDirty) scheduleSync();
}

/* ---------------- GitHub sync (Git Data API: one atomic commit per sync) ---------------- */
const GH = {
  ok() { const s = db.settings; return !!(s.owner && s.repo && s.token); },
  base() { const s = db.settings; return `https://api.github.com/repos/${s.owner}/${s.repo}`; },
  async req(method, path, body, accept) {
    const res = await fetch(this.base() + path, {
      method,
      headers: { Authorization: 'Bearer ' + db.settings.token, Accept: accept || 'application/vnd.github+json',
                 ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) { const e = new Error(method + ' ' + path + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160)); e.status = res.status; throw e; }
    return accept && accept.includes('raw') ? res.text() : res.json();
  },
  async raw(path) {           // raw media type: no 1 MB limit
    return this.req('GET', '/contents/' + path + '?ref=' + encodeURIComponent(db.settings.branch || 'main'), null, 'application/vnd.github.raw+json');
  },
  /* files: {path: text}. Unchanged files are skipped by comparing git blob hashes. */
  async commit(files, message, extraEntries) {
    const br = db.settings.branch || 'main';
    const ref = await this.req('GET', '/git/ref/heads/' + br);
    if (!ref) throw new Error('branch ' + br + ' not found');
    const head = ref.object.sha;
    const commit = await this.req('GET', '/git/commits/' + head);
    const tree = await this.req('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
    const existing = {}; (tree.tree || []).forEach(t => existing[t.path] = t.sha);
    // never let an empty phone overwrite a repo that has history
    if (!(db.sessions || []).length && Object.keys(existing).some(p => p.startsWith('data/sessions/') || p === 'data/log.json'))
      throw new Error('this phone has no sessions but GitHub does. Tap Restore from GitHub first');
    const entries = [];
    for (const p of Object.keys(files)) {
      const sha = await C.gitBlobSha(files[p]);
      if (existing[p] !== sha) entries.push({ path: p, mode: '100644', type: 'blob', content: files[p] });
    }
    (extraEntries ? extraEntries(existing) : []).forEach(e => entries.push(e));
    if (!entries.length) return { changed: 0 };
    const nt = await this.req('POST', '/git/trees', { base_tree: commit.tree.sha, tree: entries });
    const nc = await this.req('POST', '/git/commits', { message, tree: nt.sha, parents: [head] });
    await this.req('PATCH', '/git/refs/heads/' + br, { sha: nc.sha, force: false });
    return { changed: entries.length };
  }
};
/* One-time move of the v1 file: data/log.json -> data/backup/log-v1.json (same blob, no upload). */
function v1BackupEntries(existing) {
  const out = [];
  if (existing['data/log.json'] && !existing['data/backup/log-v1.json']) {
    out.push({ path: 'data/backup/log-v1.json', mode: '100644', type: 'blob', sha: existing['data/log.json'] });
    out.push({ path: 'data/log.json', mode: '100644', type: 'blob', sha: null });
  }
  return out;
}
let syncing = null, syncTimer = null, lastSyncAt = 0;
async function syncNow(silent, reason) {
  if (!GH.ok()) { if (!silent) toast('Add your GitHub details in Settings first'); return false; }
  // a sync already in flight was built from older data: let it land, then send what changed since
  if (syncing) return syncing.then(() => db.dirty ? syncNow(silent, reason) : true);
  setSyncState('syncing');
  syncing = (async () => {
    const stamp = db.changedAt;
    try {
      const files = C.repoFiles(db);
      files['data/index.json'] = JSON.stringify(buildDigest(db));
      const msg = reason || (db.active ? 'wip: ' + db.active.day + ' (' + countSets(db.active) + ' sets)' : 'sync: ' + db.sessions.length + ' sessions');
      let r;
      try { r = await GH.commit(files, msg, v1BackupEntries); }
      catch (e) { if (e.status === 422 || e.status === 409) r = await GH.commit(files, msg, v1BackupEntries); else throw e; }
      if (db.changedAt === stamp) db.dirty = false;       // edits made during the sync stay dirty
      db.lastSync = new Date().toISOString(); lastSyncAt = Date.now();
      save(); setSyncState(db.dirty ? 'dirty' : 'ok');
      if (!silent) toast(r.changed ? 'Synced to GitHub' : 'Already up to date');
      return true;
    } catch (e) {
      setSyncState('error'); console.error(e); db.lastSyncError = e.message; save();
      if (!silent) toast('Sync failed: ' + e.message);
      return false;
    } finally { syncing = null; }
  })();
  return syncing;
}
/* Debounced auto-sync. During a session it batches to at most one commit every few minutes. */
function scheduleSync() {
  if (!GH.ok() || typeof navigator === 'undefined' || !navigator.onLine) return;
  clearTimeout(syncTimer);
  const minGap = db.active ? 4 * 60000 : 0;
  const wait = Math.max(30000, minGap - (Date.now() - lastSyncAt));
  syncTimer = setTimeout(() => { if (db.dirty) syncNow(true); }, wait);
}
async function restoreFromGitHub() {
  if (!GH.ok()) return toast('Add your GitHub details first');
  if (db.dirty && !confirm('You have unsynced local changes. Replace local data with the GitHub copy?')) return;
  try {
    let incoming;
    const metaTxt = await GH.raw('data/meta.json');
    if (metaTxt) {
      const meta = JSON.parse(metaTxt);
      const years = [];
      for (const y of meta.years || []) {
        const t = await GH.raw('data/sessions/' + y + '.json');
        if (!t) throw new Error('data/sessions/' + y + '.json is missing, nothing was changed');
        years.push(JSON.parse(t));
      }
      incoming = C.fromRepoFiles(meta, years);
    } else {
      const v1 = (await GH.raw('data/log.json')) || (await GH.raw('data/backup/log-v1.json'));
      if (!v1) return toast('No LiftLog data in the repo yet');
      incoming = JSON.parse(v1);
    }
    const m = C.migrate(incoming);
    if ((m.sessions || []).length < db.sessions.length &&
        !confirm('GitHub has ' + m.sessions.length + ' sessions, this phone has ' + db.sessions.length + '. Replace anyway?')) return;
    ['sessions', 'profile', 'program', 'coachNotes', 'bodyweight', 'scans', 'aliases', 'exercises', 'plan']
      .forEach(k => { if (m[k] !== undefined) db[k] = m[k]; });
    if (!db.active && m.active) db.active = m.active;
    db.dirty = false; save(); render(); toast('Restored ' + db.sessions.length + ' sessions');
  } catch (e) { toast('Restore failed: ' + e.message); }
}

/* ---------------- coach via the Claude API (optional) ---------------- */
const COACH_SYSTEM = `You are James's strength coach, answering inside his LiftLog phone app.
His full training digest and the coaching ruleset (COACH.md) are included below. Do not try to fetch anything.
Follow COACH.md exactly, with one change for the small screen: part (a) is at most 5 short plain-text lines
(day, why, any load changes and why, one cue). No markdown table, no headings, no bold.
Then part (b): the fenced plan block in the exact COACH.md §6 format, including rest times.
Use exercise names exactly as they appear as keys in digest.lifts or in the program.
Extra guidance in "Today" always wins for today's session. Be honest when the data shows he is not progressing.`;
async function fetchCoachMd() {
  try { if (GH.ok()) { const t = await GH.raw('COACH.md'); if (t) return t; } } catch (e) {}
  const r = await fetch('COACH.md', { cache: 'no-store' });
  if (!r.ok) throw new Error('could not load COACH.md');
  return r.text();
}
async function askCoach(note) {
  const s = db.settings;
  if (!s.apiKey) throw new Error('Add a Claude API key in Settings');
  const coach = await fetchCoachMd();
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
                 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({
        model: s.model || 'claude-sonnet-5', max_tokens: 3000,
        system: COACH_SYSTEM + '\n\n=== COACH.md ===\n' + coach,
        messages: [{ role: 'user', content: 'Digest (liftlog/3):\n```json\n' + JSON.stringify(buildDigest(db)) +
          '\n```\n\nToday: ' + (note || 'no special constraints') + '\n\nWrite today\'s session.' }]
      })
    });
    const j = await res.json();
    if (!res.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + res.status);
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const x = C.extractPlanBlock(text);
    const plan = C.parseTextPlan(x.block);
    plan.brief = x.brief; plan.source = 'coach-api'; plan.note = note || '';
    return plan;
  } finally { clearTimeout(timer); }
}

/* ---------------- tiny UI framework ---------------- */
const $ = sel => document.querySelector(sel);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };
const btn = (cls, txt, fn) => { const b = el('button', cls, txt); b.onclick = fn; return b; };
let route = 'today';
const ui = { sheet: null };
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
function setSyncState(s) { const d = $('#syncdot'); if (d) d.dataset.state = s; }
function paintSyncBadge() { const d = $('#syncdot'); if (d && d.dataset.state !== 'syncing') d.dataset.state = db.dirty ? 'dirty' : (db.lastSyncError && !db.lastSync ? 'error' : 'ok'); }
function unit() { return db.settings.unit; }
function go(r) { route = r; window.scrollTo(0, 0); render(); }
const fmtW = w => (Math.round(w * 100) / 100) + '';
const setStr = (s, info) => (info && info.load === 'bw' ? (s.w ? 'BW+' + fmtW(s.w) : 'BW') : info && info.load === 'assisted' ? (s.w ? 'BW−' + fmtW(Math.abs(s.w)) : 'BW') : fmtW(s.w)) + '×' + s.r;
const fmtDate = d => { const x = new Date(d + 'T00:00:00'); return x.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
const showTarget = (t, rest) => { const base = String(t || '').replace(/\s*\brest\s*[\d:]+\s*(s|sec|secs|m|min|mins)?\b/i, '').trim(); return base + (rest ? (base ? ' · ' : '') + 'rest ' + Math.floor(rest / 60) + ':' + String(rest % 60).padStart(2, '0') : ''); };
const countSets = a => (a.ex || []).reduce((n, e) => n + (e.sets || []).length, 0);

/* ---------------- session logic ---------------- */
function lastPerformance(name, excludeId) {
  const n = canon(name, db);
  const s = db.sessions.filter(x => x.id !== excludeId).sort(byDateDesc);
  for (const sess of s) {
    const e = (sess.ex || []).find(x => canon(x.name, db) === n && (x.sets || []).length);
    if (e) { const E = readEntry(db, sess, e); return { date: sess.date, E, e1rm: E.best }; }
  }
  return null;
}
function bestEver(name, excludeId) {
  const n = canon(name, db); let b = 0;
  db.sessions.forEach(sess => { if (sess.id === excludeId) return; (sess.ex || []).forEach(e => { if (canon(e.name, db) === n) b = Math.max(b, readEntry(db, sess, e).best); }); });
  return b;
}
function programRest(name) {
  const n = canon(name, db);
  for (const d of (db.program && db.program.days) || []) for (const e of d.ex || []) if (canon(e.name, db) === n && e.rest) return e.rest;
  return null;
}
function restFor(e) { return e.rest || programRest(e.name) || exInfo(e.name, db).rest; }
function startSession(plan) {
  const p = plan || db.plan || fallbackPlan();
  db.active = {
    id: 's' + Date.now(), date: today(), day: p.day || 'Session', start: new Date().toISOString(), notes: '',
    ex: (p.ex || []).map(e => ({ name: canon(e.name, db), target: e.target || '', cue: e.cue || '', rest: e.rest || undefined, sets: [] }))
  };
  uiState.open = {}; uiState.drafts = {}; saveUi();
  save(true); go('today'); wake(true);
}
function fallbackPlan() {
  const prog = db.program && db.program.days;
  if (!prog || !prog.length) return { day: 'Freestyle', ex: [] };
  const last = db.sessions.slice().sort(byDateDesc)[0];
  let i = 0;
  if (last) { const idx = prog.findIndex(d => d.day === last.day); i = idx >= 0 ? (idx + 1) % prog.length : 0; }
  return prog[i];
}
function lastActivity(a) {
  let t = a.start;
  (a.ex || []).forEach(e => (e.sets || []).forEach(s => { if (s.at && s.at > t) t = s.at; }));
  return t;
}
function finishSession(auto) {
  const a = db.active; if (!a) return;
  a.end = auto ? lastActivity(a) : new Date().toISOString();
  a.ex = a.ex.filter(e => (e.sets || []).length);
  if (!a.ex.length) {
    if (!auto && !confirm('No sets logged. Discard this session?')) return;
    db.active = null; stopRest(); save(true); render(); return;
  }
  db.sessions.push(a); db.active = null; wake(false); stopRest(); uiState.drafts = {}; uiState.open = {}; saveUi();
  if (db.plan && db.plan.day === a.day) db.plan = null;
  save(true); render();
  if (auto) { toast('Closed ' + a.day + ' from ' + fmtDate(a.date) + ' at its last set'); syncNow(true); return; }
  toast('Session saved. Syncing…');
  syncNow(true, 'session: ' + a.date + ' ' + a.day).then(ok => toast(ok ? 'Synced. The coach can see it.' : 'Saved on this phone. Will sync when online.'));
}
/* A session left open for 3+ hours after its last set gets closed at that last set. */
function autoFinishStale() {
  const a = db.active; if (!a) return;
  const idle = Date.now() - new Date(lastActivity(a)).getTime();
  if (idle > 3 * 3600000) finishSession(true);
}

/* ---------------- rest timer + wake lock ----------------
   The timer is a timestamp in uiState.rest = {end, total, sub}, not a variable, so it keeps
   counting through a lock/unlock or a reload. After zero it counts up ("rested +0:40") until
   the next set is logged, so a glance always answers "how long have I been resting".        */
let restInt = null, wakeLock = null;
let restBeeped = !uiState.rest || Date.now() >= uiState.rest.end;
const clock = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
function startRest(sec, sub) {
  uiState.rest = { end: Date.now() + sec * 1000, total: sec, sub: sub || '' }; saveUi();
  restBeeped = false;
  LockTimer.start(sec, uiState.rest.sub);
  if (db.settings.bigTimer) openRestFull();
  tickRest();
}
function tickRest() { if (restInt) clearInterval(restInt); restInt = setInterval(paintRest, 250); paintRest(); }
function stopRest() { uiState.rest = null; saveUi(); LockTimer.stop(); closeRestFull(); paintRest(); }
function addRest(sec) {
  const R = uiState.rest; if (!R) return;
  const left = R.end - Date.now();
  if (left <= 0) { R.end = Date.now() + sec * 1000; R.total = sec; restBeeped = false; }
  else { R.end += sec * 1000; R.total += sec; }
  saveUi(); LockTimer.start(Math.round((R.end - Date.now()) / 1000), R.sub); tickRest();
}
function paintRest() {
  const bar = $('#rest'), R = uiState.rest; if (!bar) return;
  const full = $('#restFull');
  if (!R) { bar.classList.remove('show'); if (full) full.classList.remove('show'); if (restInt) { clearInterval(restInt); restInt = null; } return; }
  const ms = R.end - Date.now(), over = ms <= 0;
  if (over && -ms > 20 * 60000) return stopRest();                 // walked away; clear it
  if (over && !restBeeped) { restBeeped = true; if (-ms < 4000 && !LockTimer.used) beep(); }
  const txt = over ? '+' + clock(Math.floor(-ms / 1000)) : clock(Math.ceil(ms / 1000));
  const frac = over ? 0 : Math.max(0, Math.min(1, ms / (R.total * 1000)));
  bar.classList.add('show'); bar.classList.toggle('over', over);
  $('#restTime').textContent = txt; $('#restLabel').textContent = over ? 'Rested' : 'Rest';
  $('#restSub').textContent = (R.sub || '').replace(/^Next: /, ''); $('#restFill').style.transform = 'scaleX(' + frac + ')';
  if (full && full.classList.contains('show')) {
    full.classList.toggle('over', over);
    $('#rfTime').textContent = txt; $('#rfLabel').textContent = over ? 'Go. Rested' : 'Rest';
    $('#rfSub').textContent = R.sub || ''; $('#rfFill').style.transform = 'scaleY(' + frac + ')';
  }
}
function openRestFull() { const f = $('#restFull'); if (f && uiState.rest) { f.classList.add('show'); paintRest(); } }
function closeRestFull() { const f = $('#restFull'); if (f) f.classList.remove('show'); }
/* What the timer says is coming, e.g. "Lat Pulldown, set 3 of 3". */
function nextUp(a, e) {
  const i = a.ex.indexOf(e), order = a.ex.slice(i).concat(a.ex.slice(0, i));
  for (const x of order) {
    const info = exInfo(x.name, db), t = parseTarget(x.target);
    const done = C.warmupFlags(x.sets, info).filter(w => !w).length;
    if (t.sets ? done < t.sets : (x === e || !(x.sets || []).length))
      return 'Next: ' + info.name + ', set ' + (done + 1) + (t.sets ? ' of ' + t.sets : '');
  }
  return 'All planned sets done';
}

/* Lock-screen timer (opt-in). A web app cannot post a Live Activity, but anything playing audio
   gets the lock screen's Now Playing card, with a progress bar and time remaining. So a rest is
   played as a silent track of exactly that length that ends in three beeps. The cost: iOS gives
   the audio session to LiftLog, which pauses music playing from the same phone.              */
const LockTimer = {
  audio: null, urls: {}, used: false,
  supported() { return typeof Audio !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && !!URL.createObjectURL; },
  wav(sec) {                                   // 8 kHz 16-bit mono: about 1 MB per minute, in memory only
    const rate = 8000, n = Math.round(sec * rate), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    const len = Math.round(0.16 * rate), gap = Math.round(0.12 * rate), start = Math.max(0, n - 3 * len - 2 * gap - 400);
    for (let b = 0; b < 3; b++) for (let i = 0; i < len; i++) {
      const at = start + b * (len + gap) + i; if (at >= n) break;
      const env = Math.min(1, i / 80, (len - i) / 80);
      v.setInt16(44 + at * 2, Math.round(Math.sin(2 * Math.PI * 880 * i / rate) * env * 0.5 * 32767), true);
    }
    return buf;
  },
  track(sec) {
    sec = Math.max(2, Math.round(sec));
    if (this.urls[sec]) return this.urls[sec];
    const keys = Object.keys(this.urls);
    if (keys.length >= 8) { URL.revokeObjectURL(this.urls[keys[0]]); delete this.urls[keys[0]]; }
    return this.urls[sec] = URL.createObjectURL(new Blob([this.wav(sec)], { type: 'audio/wav' }));
  },
  start(sec, sub) {
    this.used = false;
    if (!db.settings.lockTimer || !this.supported() || sec < 2) return;
    try {
      if (!this.audio) { this.audio = new Audio(); this.audio.preload = 'auto'; this.audio.addEventListener('ended', () => this.meta(null)); }
      this.audio.src = this.track(sec);
      const p = this.audio.play(); if (p && p.catch) p.catch(() => { this.used = false; });
      this.used = true; this.meta(sub || 'Rest');
    } catch (e) { this.used = false; }
  },
  meta(title) {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession; if (!ms) return;
    try {
      if (!title) { ms.playbackState = 'none'; return; }
      if (typeof MediaMetadata !== 'undefined') ms.metadata = new MediaMetadata({ title, artist: 'Rest timer', album: 'LiftLog',
        artwork: [{ src: 'icon.png', sizes: '512x512', type: 'image/png' }] });
      ms.playbackState = 'playing';
      ms.setActionHandler('nexttrack', () => stopRest());          // lock screen: skip rest
      ms.setActionHandler('previoustrack', () => addRest(30));     // lock screen: +30 s
      ms.setActionHandler('pause', () => stopRest());
      ms.setActionHandler('play', () => {});
    } catch (e) {}
  },
  stop() { if (this.audio && this.used) { try { this.audio.pause(); } catch (e) {} } this.used = false; this.meta(null); }
};
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.25, c.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.5);
    o.start(); o.stop(c.currentTime + 0.55);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  } catch (e) {}
}
async function wake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}

/* ---------------- render ---------------- */
function render() {
  const main = $('#main'); const y = window.scrollY; const same = main.dataset.route === route;
  main.innerHTML = ''; main.dataset.route = route;
  const top = route.split(':')[0];
  const tab = { session: 'history', lift: 'stats' }[top] || top;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.route === tab));
  const views = { today: viewToday, history: viewHistory, session: viewSession, stats: viewStats, lift: viewLift, settings: viewSettings };
  (views[top] || viewToday)(main, route.slice(top.length + 1));
  paintSyncBadge();
  if (same) window.scrollTo(0, y);
}
function card(root, kicker, cls) { const c = el('div', 'card' + (cls ? ' ' + cls : '')); if (kicker) c.appendChild(el('div', 'kicker', kicker)); root.appendChild(c); return c; }

/* --- bottom sheet (set editor, pickers) --- */
function openSheet(build) {
  closeSheet();
  const back = el('div', 'sheet-back'); back.onclick = e => { if (e.target === back) closeSheet(); };
  const sh = el('div', 'sheet'); back.appendChild(sh);
  build(sh);
  document.body.appendChild(back); ui.sheet = back;
  requestAnimationFrame(() => back.classList.add('show'));
}
function closeSheet() { if (ui.sheet) { ui.sheet.remove(); ui.sheet = null; } }

/* number field with - / + and a real decimal keypad (no prompt()) */
function numField(label, value, step, onChange, opts) {
  opts = opts || {};
  const g = el('div', 'stepper');
  g.appendChild(el('div', 'slabel', label));
  const row = el('div', 'srow');
  const inp = el('input', 'sval'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = fmtW(value);
  inp.onfocus = () => inp.select();
  const clamp = v => opts.min !== undefined ? Math.max(opts.min, v) : v;
  const setV = v => { v = clamp(Math.round(v * 100) / 100); inp.value = fmtW(v); onChange(v); };
  inp.onchange = () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isNaN(v)) setV(v); else inp.value = fmtW(value); };
  inp.oninput = () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isNaN(v)) onChange(clamp(v)); };   // typed but not yet confirmed
  row.appendChild(btn('sbtn', '−', () => setV((parseFloat(inp.value) || 0) - step)));
  row.appendChild(inp);
  row.appendChild(btn('sbtn', '+', () => setV((parseFloat(inp.value) || 0) + step)));
  g.appendChild(row);
  return g;
}
function editSetSheet(entry, idx, onDone) {
  const s = entry.sets[idx]; const info = exInfo(entry.name, db);
  const w0 = C.warmupFlags(entry.sets, info)[idx];
  const v = { w: s.w, r: s.r, rir: hasRir(s) ? s.rir : 2, warm: w0 };
  openSheet(sh => {
    sh.appendChild(el('div', 'kicker', 'Edit set ' + (idx + 1)));
    sh.appendChild(el('h3', '', info.name));
    const g = el('div', 'entry');
    g.appendChild(numField('Weight', v.w, info.step, x => v.w = x, { min: 0 }));
    g.appendChild(numField('Reps', v.r, 1, x => v.r = x, { min: 0 }));
    g.appendChild(numField('RIR', v.rir, 1, x => v.rir = x, { min: 0 }));
    sh.appendChild(g);
    const wt = el('label', 'toggle'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = v.warm;
    cb.onchange = () => v.warm = cb.checked; wt.appendChild(cb); wt.appendChild(el('span', '', 'Warm-up set (not counted)'));
    sh.appendChild(wt);
    const row = el('div', 'btnrow');
    row.appendChild(btn('primary', 'Save', () => {
      Object.assign(s, { w: v.w, r: v.r, rir: v.rir, t: v.warm ? 'w' : 'n' });
      closeSheet(); save(true); onDone && onDone(); render();
    }));
    row.appendChild(btn('', 'Delete set', () => { entry.sets.splice(idx, 1); closeSheet(); save(true); onDone && onDone(); render(); }));
    row.appendChild(btn('ghost', 'Cancel', closeSheet));
    sh.appendChild(row);
  });
}
/* Other library lifts that train the same movement, for one-tap swaps. */
function sameMovement(name) {
  const me = exInfo(name, db); if (me.pattern === 'other') return [];
  const done = liftSeries(db);
  return Object.keys(C.CATALOG).concat(Object.keys(db.exercises || {})).filter(n => n !== me.name && exInfo(n, db).pattern === me.pattern)
    .sort((x, y) => (done[y] ? 1 : 0) - (done[x] ? 1 : 0) || x.localeCompare(y));
}
function pickExerciseSheet(title, onPick, exclude, suggest) {
  openSheet(sh => {
    sh.appendChild(el('div', 'kicker', title));
    const inp = el('input'); inp.placeholder = 'Search or type a new name'; sh.appendChild(inp);
    const list = el('div', 'picklist'); sh.appendChild(list);
    suggest = (suggest || []).filter(n => n !== exclude);
    const names = [...new Set([...Object.keys(C.CATALOG), ...Object.keys(liftSeries(db)), ...Object.keys(db.exercises || {})])]
      .filter(n => n !== exclude).sort();
    const paint = () => {
      list.innerHTML = ''; const q = inp.value.trim().toLowerCase();
      const hits = names.filter(n => !q || n.toLowerCase().includes(q)).slice(0, 40);
      if (q && !names.some(n => n.toLowerCase() === q)) hits.unshift('＋ ' + inp.value.trim());
      if (!q && suggest.length) {
        list.appendChild(el('div', 'group', 'Same movement'));
        suggest.forEach(n => list.appendChild(btn('pick', n, () => { closeSheet(); onPick(n); })));
        list.appendChild(el('div', 'group', 'Everything'));
      }
      hits.forEach(n => list.appendChild(btn('pick', n, () => { closeSheet(); onPick(n.replace(/^＋ /, '')); })));
    };
    inp.oninput = paint; paint();
    sh.appendChild(btn('ghost', 'Cancel', closeSheet));
    setTimeout(() => inp.focus(), 50);
  });
}

/* --- TODAY --- */
function viewToday(root) {
  if (db.active) return viewActive(root);
  weekStrip(root);
  const plan = db.plan;
  const c = card(root, plan ? "Coach's plan" + (plan.date ? ' · ' + fmtDate(plan.date) : '') : 'No plan loaded');
  if (plan) {
    c.appendChild(el('h2', '', plan.day || 'Session'));
    if (plan.focus) c.appendChild(el('p', 'muted', plan.focus));
    if (plan.brief) { const b = el('div', 'brief', plan.brief); c.appendChild(b); }
    const list = el('div', 'exlist');
    (plan.ex || []).forEach(e => {
      const row = el('div', 'exrow');
      const l = el('div', ''); l.appendChild(el('div', 'exname', canon(e.name, db))); l.appendChild(el('div', 'muted small', showTarget(e.target, e.rest)));
      row.appendChild(l);
      const lp = lastPerformance(e.name);
      if (lp) row.appendChild(el('div', 'muted small right', 'last ' + lp.E.work.map(s => setStr(s, lp.E.info)).join(', ')));
      list.appendChild(row);
    });
    c.appendChild(list);
    if (plan.notes) c.appendChild(el('p', 'note', plan.notes));
    c.appendChild(btn('primary big', 'Start session', () => startSession(plan)));
    c.appendChild(btn('ghost', 'Clear plan', () => { db.plan = null; save(true); render(); }));
  } else {
    c.appendChild(el('h2', '', 'Get today\'s session'));
    c.appendChild(el('p', 'muted small', db.settings.apiKey ? 'Ask the coach below, or paste a plan from the Claude chat.' : 'Copy the plan block from the Claude chat, then tap Paste plan.'));
  }

  // handoff: paste (always) + ask the coach (when an API key is set)
  const h = card(root, 'Load a plan');
  const row = el('div', 'btnrow');
  row.appendChild(btn(plan ? '' : 'primary', 'Paste plan', pastePlan));
  if (!plan) row.appendChild(btn('', 'Start ' + (fallbackPlan().day || 'session') + ' from program', () => startSession(fallbackPlan())));
  h.appendChild(row);
  if (db.settings.apiKey) {
    const note = el('input'); note.placeholder = 'Anything today? e.g. 45 min, shoulder cranky';
    h.appendChild(note);
    const ask = btn(plan ? '' : 'primary', 'Ask the coach for today\'s plan', async () => {
      ask.disabled = true; ask.textContent = 'Coach is thinking…';
      try { db.plan = await askCoach(note.value.trim()); save(true); render(); toast('Plan loaded'); }
      catch (e) { toast('Coach failed: ' + e.message); ask.disabled = false; ask.textContent = 'Try again'; }
    });
    h.appendChild(ask);
  }
  const det = el('details'); det.appendChild(el('summary', 'muted small', 'Paste manually'));
  const ta = el('textarea'); ta.placeholder = "Paste the coach's reply or plan block"; ta.rows = 4; det.appendChild(ta);
  det.appendChild(btn('', 'Load', () => loadPlanText(ta.value)));
  h.appendChild(det);

  const nc = card(root, 'Standing notes for the coach');
  const nta = el('textarea'); nta.rows = 3; nta.value = db.coachNotes || '';
  nta.placeholder = 'e.g. left shoulder dislikes flat barbell benching; only 45 min on Thursdays';
  nta.oninput = () => { db.coachNotes = nta.value; save(true); };
  nc.appendChild(nta);

  card(root, null).appendChild(bodyweightRow());
}
/* This week at a glance: which days were trained, against the plan. */
function weekStrip(root) {
  const target = (db.profile && db.profile.days_per_week) || 4, ws = C.weekStart(today());
  const days = new Set(db.sessions.map(s => s.date)), c = card(root, null, 'week');
  const row = el('div', 'wk'); let n = 0;
  'MTWTFSS'.split('').forEach((l, i) => {
    const d = addDays(ws, i), on = days.has(d); if (on) n++;
    const cell = el('div', 'wd' + (on ? ' on' : '') + (d === today() ? ' today' : '')); cell.appendChild(el('i', '', on ? '✓' : '')); cell.appendChild(el('span', '', l)); row.appendChild(cell);
  });
  c.appendChild(row);
  const last = db.sessions.slice().sort(byDateDesc)[0], ago = last ? daysAgo(last.date) : null;
  c.appendChild(el('div', 'muted small', n + ' of ' + target + ' this week' + (last ? ' · last session ' + (ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago + ' days ago') + ' (' + last.day + ')' : '')));
}
function loadPlanText(v) {
  v = String(v || '').trim(); if (!v) return false;
  try { db.plan = C.parseAnyPlan(v); save(true); render(); toast('Plan loaded: ' + db.plan.day); return true; }
  catch (e) { toast('Could not read that plan'); return false; }
}
async function pastePlan() {
  try {
    const t = await navigator.clipboard.readText();
    if (!loadPlanText(t)) toast('Clipboard has no plan. Copy the plan block in Claude first.');
  } catch (e) { toast('Clipboard blocked. Use "Paste manually".'); }
}

/* --- ACTIVE SESSION --- */
function viewActive(root) {
  const a = db.active;
  const head = card(root, 'In progress · ' + fmtDate(a.date));
  head.appendChild(el('h2', '', a.day));
  const meta = el('div', 'muted small'); meta.id = 'actMeta'; head.appendChild(meta);
  const planned = a.ex.reduce((n, e) => n + (parseTarget(e.target).sets || 0), 0);
  const doneWork = a.ex.reduce((n, e) => { const t = parseTarget(e.target).sets, d = C.warmupFlags(e.sets, exInfo(e.name, db)).filter(x => !x).length; return n + (t ? Math.min(d, t) : 0); }, 0);
  if (planned) {
    const tr = el('div', 'btrack prog'), fl = el('div', 'bfill'); fl.style.width = Math.round(doneWork / planned * 100) + '%'; tr.appendChild(fl); head.appendChild(tr);
    head.appendChild(el('div', 'muted tiny-note', doneWork + ' of ' + planned + ' planned sets'));
  }
  paintActiveMeta();

  a.ex.forEach((e, ei) => {
    const info = exInfo(e.name, db), t = parseTarget(e.target);
    const done = (e.sets || []).length, workDone = C.warmupFlags(e.sets, info).filter(w => !w).length;
    const complete = t.sets && workDone >= t.sets;
    const key = ei + ':' + e.name;
    const open = uiState.open[key] !== undefined ? uiState.open[key] : !complete;
    const c = card(root, null, complete ? 'done' : '');
    const top = el('div', 'exhead');
    const l = el('div', ''); l.onclick = () => { uiState.open[key] = !open; saveUi(); render(); };
    l.appendChild(el('div', 'exname', info.name));
    l.appendChild(el('div', 'muted small', showTarget(e.target, restFor(e))));
    top.appendChild(l);
    top.appendChild(el('div', 'chip' + (complete ? ' ok' : ''), (t.sets ? workDone + '/' + t.sets : String(done))));
    top.appendChild(btn('ghost tiny', '⋯', () => exerciseMenu(a, ei)));
    c.appendChild(top);
    if (!open) return;

    const lp = lastPerformance(e.name, a.id);
    if (lp) c.appendChild(el('div', 'lastline', 'Last ' + fmtDate(lp.date) + ': ' + lp.E.work.map(s => setStr(s, info) + (s.rir !== '' ? '@' + s.rir : '')).join('  ') + '  ·  e1RM ' + lp.e1rm));
    if (e.cue) c.appendChild(el('div', 'note', e.cue));
    c.appendChild(el('div', 'muted tiny-note', 'Weight is ' + (LOAD_NOTE[info.load] || '') + (info.perSide ? ' · log each side as its own set' : '')));

    const flags = C.warmupFlags(e.sets, info);
    (e.sets || []).forEach((s, si) => {
      const r = el('div', 'setrow' + (flags[si] ? ' warm' : ''));
      r.onclick = () => editSetSheet(e, si);
      r.appendChild(el('div', 'setno', flags[si] ? 'W' : String(flags.slice(0, si + 1).filter(x => !x).length)));
      r.appendChild(el('div', 'setval', setStr(s, info) + (hasRir(s) ? '  @' + s.rir : '')));
      r.appendChild(el('div', 'muted small', flags[si] ? 'warm-up' : 'e1RM ' + e1rm(C.effLoad(db, info, s.w, a.date), s.r)));
      c.appendChild(r);
    });
    c.appendChild(setEntry(e, lp, info, t));
  });

  const add = card(root, null);
  add.appendChild(btn('big', '＋ Add exercise', () => pickExerciseSheet('Add exercise', n => {
    a.ex.push({ name: canon(n, db), target: '', sets: [] }); save(true); render();
  })));

  const nc = card(root, 'Session notes');
  const ta = el('textarea'); ta.rows = 2; ta.value = a.notes || '';
  ta.placeholder = 'Energy, pain, sleep, swaps, anything the coach should know';
  ta.oninput = () => { a.notes = ta.value; save(true); };
  nc.appendChild(ta);

  const fin = card(root, null);
  fin.appendChild(btn('primary big', 'Finish & sync', () => finishSession(false)));
  fin.appendChild(btn('ghost', 'Discard session', () => { if (confirm('Discard this session?')) { db.active = null; wake(false); stopRest(); uiState.drafts = {}; saveUi(); save(true); render(); } }));
}
function paintActiveMeta() {
  const m = $('#actMeta'), a = db.active; if (!m || !a) return;
  const mins = Math.round((Date.now() - new Date(a.start).getTime()) / 60000);
  m.textContent = mins + ' min · ' + countSets(a) + ' sets · volume ' + sessionVolume(a, db).toLocaleString() + ' ' + unit();
}
function exerciseMenu(a, ei) {
  const e = a.ex[ei];
  openSheet(sh => {
    sh.appendChild(el('div', 'kicker', exInfo(e.name, db).name));
    sh.appendChild(btn('big', 'Swap for another exercise', () => pickExerciseSheet('Swap ' + e.name + ' for', n => {
      const from = e.name; e.name = canon(n, db);
      a.notes = (a.notes ? a.notes + ' ' : '') + '[swapped ' + from + ' → ' + e.name + ']';
      save(true); render();
    }, e.name, sameMovement(e.name))));
    if (ei > 0) sh.appendChild(btn('big', 'Move up', () => { a.ex.splice(ei - 1, 0, a.ex.splice(ei, 1)[0]); closeSheet(); save(true); render(); }));
    sh.appendChild(btn('big', 'Remove from session', () => { if (confirm('Remove ' + e.name + '?')) { a.ex.splice(ei, 1); closeSheet(); save(true); render(); } }));
    sh.appendChild(btn('ghost', 'Cancel', closeSheet));
  });
}
/* the fast set-entry widget. Whatever is dialled in is kept as a draft until the set is logged,
   so locking the phone mid-entry never resets it to the defaults. */
function setEntry(e, lp, info, t) {
  const prev = (e.sets || [])[e.sets.length - 1];
  const lastWork = lp ? lp.E.work[lp.E.work.length - 1] : null;
  let w = prev ? prev.w : lastWork ? lastWork.w : 0, r = prev ? prev.r : lastWork ? lastWork.r : 8;
  let rir = prev && hasRir(prev) ? prev.rir : t.rir !== null ? t.rir : 2;
  if (!prev && e.target) {                         // aim at the top of the range, at the prescribed load
    if (t.hi) r = t.hi;
    if (t.load !== null) w = info.load === 'assisted' ? Math.abs(t.load) : Math.max(0, t.load);
  }
  let warm = false;
  const dk = db.active.id + '|' + e.name, d = uiState.drafts[dk];
  if (d) { w = d.w; r = d.r; rir = d.rir; warm = !!d.warm; }
  const keep = () => { uiState.drafts[dk] = { w, r, rir, warm }; saveUi(); };
  const box = el('div', 'entry');
  box.appendChild(numField(info.load === 'assisted' ? 'Assist' : info.load === 'bw' ? 'Added' : 'Weight', w, info.step, v => { w = v; keep(); }, { min: 0 }));
  box.appendChild(numField('Reps', r, 1, v => { r = v; keep(); }, { min: 0 }));
  box.appendChild(numField('RIR', rir, 1, v => { rir = v; keep(); }, { min: 0 }));
  const wb = btn('warmbtn' + (warm ? ' on' : ''), 'Warm-up', () => { warm = !warm; wb.classList.toggle('on', warm); keep(); });
  box.appendChild(wb);
  box.appendChild(btn('primary logbtn', 'Log set', () => {
    if (!r) return;
    const best = warm ? 0 : bestEver(e.name, db.active.id);
    e.sets.push({ w, r, rir, t: warm ? 'w' : 'n', at: new Date().toISOString() });
    delete uiState.drafts[dk]; saveUi();
    save(true); startRest(warm ? 60 : restFor(e), nextUp(db.active, e)); render();
    const now = warm ? 0 : e1rm(C.effLoad(db, info, w, db.active.date), r);
    if (best && now > best) { toast('New e1RM PR on ' + info.name + ': ' + now + ' ' + unit()); if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 120]); }
  }));
  return box;
}

/* --- HISTORY --- */
function viewHistory(root) {
  const s = db.sessions.slice().sort(byDateDesc);
  if (!s.length) { card(root, null).textContent = 'No sessions yet.'; return; }
  s.forEach(sess => {
    const c = card(root, fmtDate(sess.date) + ' · ' + (sess.day || ''), 'tap');
    c.onclick = () => go('session:' + sess.id);
    (sess.ex || []).forEach(e => {
      const E = readEntry(db, sess, e);
      const r = el('div', 'exrow');
      r.appendChild(el('div', 'exname small', E.name));
      r.appendChild(el('div', 'muted small right', E.work.map(x => setStr(x, E.info)).join(', ')));
      c.appendChild(r);
    });
    c.appendChild(el('div', 'muted small', 'Volume ' + sessionVolume(sess, db).toLocaleString() + ' ' + unit()));
    if (sess.notes) c.appendChild(el('div', 'note clamp', sess.notes));
  });
}
function viewSession(root, id) {
  const sess = db.sessions.find(s => s.id === id);
  if (!sess) { go('history'); return; }
  root.appendChild(btn('ghost back', '‹ History', () => go('history')));
  const h = card(root, 'Session');
  const d = el('input'); d.type = 'date'; d.value = sess.date; d.onchange = () => { if (d.value) { sess.date = d.value; save(true); } };
  const day = el('input'); day.value = sess.day || ''; day.onchange = () => { sess.day = day.value.trim(); save(true); };
  h.appendChild(d); h.appendChild(day);
  (sess.ex || []).forEach(e => {
    const E = readEntry(db, sess, e);
    const c = card(root, null);
    const top = el('div', 'exhead');
    const l = el('div', ''); l.appendChild(el('div', 'exname', E.name));
    l.appendChild(el('div', 'muted small', (e.target || '') + (E.raw !== E.name ? ' · logged as ' + E.raw : '')));
    l.onclick = () => go('lift:' + E.name);
    top.appendChild(l); c.appendChild(top);
    E.sets.forEach((s, si) => {
      const r = el('div', 'setrow' + (s.warm ? ' warm' : ''));
      r.onclick = () => editSetSheet(e, si);
      r.appendChild(el('div', 'setno', s.warm ? 'W' : String(E.sets.slice(0, si + 1).filter(x => !x.warm).length)));
      r.appendChild(el('div', 'setval', setStr(s, E.info) + (s.rir !== '' ? '  @' + s.rir : '')));
      r.appendChild(el('div', 'muted small', s.warm ? 'warm-up' : 'e1RM ' + s.e1));
      c.appendChild(r);
    });
    c.appendChild(el('div', 'muted small', 'Tap a set to edit it or mark it as a warm-up.'));
  });
  const nc = card(root, 'Notes');
  const ta = el('textarea'); ta.rows = 4; ta.value = sess.notes || ''; ta.onchange = () => { sess.notes = ta.value; save(true); };
  nc.appendChild(ta);
  const dc = card(root, null);
  dc.appendChild(btn('ghost', 'Delete this session', () => {
    if (confirm('Delete the ' + sess.day + ' session from ' + sess.date + '? It stays in GitHub history.')) {
      db.sessions = db.sessions.filter(s => s.id !== id); save(true); go('history');
    }
  }));
}

/* --- PROGRESS (the Stats tab) ---
   Four screens, each answering one question:
   Overview: am I showing up, and is the whole thing moving?   Lifts: which lifts are and are not?
   Volume: is each muscle getting enough work?                 Body: scans and bodyweight vs the goal. */
const STATUS = { pr: ['PR', 'ok'], progressing: ['progressing', 'ok'], rebuilding: ['rebuilding', 'warn'], stalled: ['stalled', 'down'], new: ['new', ''], idle: ['resting', ''] };
const STATUS_NOTE = {
  pr: 'Best ever last time out.', progressing: 'Within 5% of your best and still moving.',
  rebuilding: 'More than 5% under your best, usually after a break. Not a stall.',
  stalled: 'Three or more sessions in this block without beating the block best.',
  new: 'Fewer than three sessions, too early to judge.', idle: 'Not done in the last five weeks.'
};
function statusChip(sum) { const s = STATUS[sum.status] || STATUS.new; return el('div', 'chip ' + s[1], s[0]); }
function viewStats(root, sub) {
  sub = sub || 'overview';
  const seg = el('div', 'seg');
  [['overview', 'Overview'], ['lifts', 'Lifts'], ['volume', 'Volume'], ['body', 'Body']].forEach(([k, l]) => seg.appendChild(btn(k === sub ? 'on' : '', l, () => go('stats:' + k))));
  root.appendChild(seg);
  if (!db.sessions.length && sub !== 'body') { card(root, null).appendChild(el('div', 'muted', 'Nothing logged yet. Your progress shows up here after the first session.')); return; }
  ({ overview: statsOverview, lifts: statsLifts, volume: statsVolume, body: statsBody }[sub] || statsOverview)(root);
}
function statsOverview(root) {
  const series = liftSeries(db), bs = C.blockStart(db), target = (db.profile && db.profile.days_per_week) || 4;
  const weeks = C.weeklyStats(db, 16), lo = C.layoffs(db), si = C.strengthIndex(db, series), prs = C.prFeed(db, series);
  const last28 = db.sessions.filter(s => daysAgo(s.date) <= 28 && daysAgo(s.date) >= 0).length;
  const w12 = weeks.slice(-12), avg = round1(w12.reduce((n, w) => n + w.sessions, 0) / w12.length);

  // 1. consistency first: it decides everything else on this page
  const c = card(root, 'Showing up');
  const h = el('div', 'headline'); h.appendChild(el('span', 'big-num', String(last28))); h.appendChild(el('span', 'muted', ' of ' + target * 4 + ' planned sessions in the last 28 days'));
  c.appendChild(h);
  c.appendChild(weekBars(weeks, target));
  c.appendChild(el('div', 'muted small', 'Sessions per week, last 16 weeks. The line is your plan of ' + target + '. 12-week average: ' + avg + ' a week.'));
  if (lo.length) c.appendChild(el('div', 'note', lo.length + (lo.length === 1 ? ' break' : ' breaks') + ' of 10+ days so far (' + lo.map(x => x.days + ' days').join(', ') + '). After each one the plan drops loads about 10% and builds back, which is why so many lifts read "rebuilding". Current run: ' +
    db.sessions.filter(s => s.date >= bs).length + ' sessions since ' + fmtDate(bs) + '.'));

  // 2. one line for overall strength
  if (si.length >= 2) {
    const s = card(root, 'Strength index'), L = si[si.length - 1], peak = si.reduce((m, x) => x.all > m.all ? x : m, si[0]);
    const hh = el('div', 'headline'); hh.appendChild(el('span', 'big-num', String(L.all)));
    hh.appendChild(el('span', 'muted', ' now · peak ' + peak.all + ' on ' + fmtDate(peak.date)));
    s.appendChild(hh);
    const pts = k => si.filter(x => x[k] !== null).map(x => ({ date: x.date, y: x[k] }));
    s.appendChild(lineChart(pts('all').map(p => Object.assign(p, { label: 'all lifts' })), { height: 180, bands: lo, label: 'Strength index over time', dots: false,
      extra: [{ points: pts('upper'), color: 'var(--accent2)' }, { points: pts('lower'), color: 'var(--warn)' }] }));
    const lg = el('div', 'legend');
    [['var(--accent)', 'All lifts ' + L.all], ['var(--accent2)', 'Upper ' + (L.upper === null ? 'n/a' : L.upper)], ['var(--warn)', 'Lower ' + (L.lower === null ? 'n/a' : L.lower)]].forEach(([col, t]) => {
      const i = el('span', 'lg'); const d = el('i'); d.style.background = col; i.appendChild(d); i.appendChild(document.createTextNode(t)); lg.appendChild(i); });
    if (lo.length) { const i = el('span', 'lg'); const d = el('i', 'band'); i.appendChild(d); i.appendChild(document.createTextNode('break')); lg.appendChild(i); }
    s.appendChild(lg);
    s.appendChild(el('div', 'muted small', 'Every lift with 3+ sessions, scaled so its first session is 100, then averaged. 110 means you are about 10% stronger across the board than when you started each lift.'));
  }

  // 3. where each lift stands
  const names = Object.keys(series), sums = {}; names.forEach(n => sums[n] = liftSummary(series[n], today(), { blockStart: bs }));
  const live = names.filter(n => sums[n].status !== 'idle');
  const st = card(root, 'Where each lift stands');
  const order = ['pr', 'progressing', 'rebuilding', 'stalled', 'new'], count = {}; live.forEach(n => count[sums[n].status] = (count[sums[n].status] || 0) + 1);
  const split = el('div', 'split');
  order.forEach(k => { if (!count[k]) return; const b = el('div', 'part ' + (STATUS[k][1] || 'none')); b.style.flex = count[k]; b.textContent = count[k]; split.appendChild(b); });
  st.appendChild(split);
  const lg2 = el('div', 'legend');
  order.forEach(k => { if (!count[k]) return; const i = el('span', 'lg'); const d = el('i', 'sq ' + (STATUS[k][1] || 'none')); i.appendChild(d); i.appendChild(document.createTextNode(count[k] + ' ' + STATUS[k][0])); lg2.appendChild(i); });
  st.appendChild(lg2);
  const behind = live.filter(n => sums[n].sessions >= 3 && sums[n].pct < 100).sort((a, b) => sums[a].pct - sums[b].pct).slice(0, 4);
  if (behind.length) {
    st.appendChild(el('div', 'group', 'Furthest below their best'));
    behind.forEach(n => {
      const r = el('div', 'liftrow'); r.onclick = () => go('lift:' + n);
      const l = el('div', 'lname'); l.appendChild(el('div', 'exname small', n));
      l.appendChild(el('div', 'muted tiny-note', Math.round(sums[n].last.best) + ' now, best ' + Math.round(sums[n].best) + ' on ' + fmtDate(sums[n].bestDate)));
      r.appendChild(l); r.appendChild(pctBar(sums[n].pct)); st.appendChild(r);
    });
  }
  st.appendChild(btn('', 'All lifts', () => go('stats:lifts')));

  // 4. PR feed
  const pc = card(root, 'Personal records');
  const pr28 = prs.filter(p => daysAgo(p.date) <= 28).length;
  pc.appendChild(el('div', 'muted small', pr28 + ' in the last 28 days, ' + prs.length + ' all time (best estimated 1RM on a lift).'));
  prs.slice(0, 6).forEach(p => {
    const r = el('div', 'exrow'); r.onclick = () => go('lift:' + p.name);
    const l = el('div', ''); l.appendChild(el('div', 'small', p.name)); l.appendChild(el('div', 'muted tiny-note', fmtDate(p.date) + ' · ' + setStr(p.top, exInfo(p.name, db))));
    r.appendChild(l);
    const rr = el('div', 'right'); rr.appendChild(el('div', 'small', String(p.e1))); rr.appendChild(el('div', 'tiny-note up', '+' + round1(p.e1 - p.prev)));
    r.appendChild(rr); pc.appendChild(r);
  });
  if (!prs.length) pc.appendChild(el('div', 'muted small', 'None yet.'));
}
function pctBar(pct) {
  const w = el('div', 'pct'); const t = el('div', 'btrack'), f = el('div', 'bfill' + (pct < 85 ? ' high' : pct < 95 ? ' low' : '')); f.style.width = Math.max(4, Math.min(100, pct)) + '%';
  t.appendChild(f); w.appendChild(t); w.appendChild(el('div', 'bval', pct + '%')); return w;
}
function statsLifts(root) {
  const series = liftSeries(db), bs = C.blockStart(db), names = Object.keys(series), sums = {};
  names.forEach(n => sums[n] = liftSummary(series[n], today(), { blockStart: bs }));
  const lc = card(root, 'Estimated 1RM, latest session. Tap a lift for its history.');
  const row = (n, host) => {
    const S = series[n], sum = sums[n];
    const r = el('div', 'liftrow'); r.onclick = () => go('lift:' + n);
    const l = el('div', 'lname'); l.appendChild(el('div', 'exname small', n));
    l.appendChild(el('div', 'muted tiny-note', S.length + ' session' + (S.length > 1 ? 's' : '') + ' · last ' + fmtDate(sum.last.date) + (sum.sessions >= 3 && sum.pct < 100 ? ' · ' + sum.pct + '% of best' : '')));
    r.appendChild(l);
    r.appendChild(sparkline(S.map(p => p.best)));
    const v = el('div', 'lval'); v.appendChild(el('div', 'num', String(Math.round(sum.last.best))));
    v.appendChild(statusChip(sum));
    r.appendChild(v); host.appendChild(r);
  };
  const groups = {}, idle = [];
  names.forEach(n => { if (sums[n].status === 'idle') return idle.push(n); const i = exInfo(n, db), k = i.known ? i.kind : '?'; (groups[k] = groups[k] || []).push(n); });
  ['lc', 'uc', 'iso', 'core', 'power', '?'].forEach(k => {
    if (!groups[k]) return;
    lc.appendChild(el('div', 'group', KIND_LABEL[k]));
    groups[k].sort((a, b) => series[b].length - series[a].length || a.localeCompare(b)).forEach(n => row(n, lc));
  });
  if (idle.length) {
    const d = el('details'); d.appendChild(el('summary', 'muted small', idle.length + ' not done in the last 5 weeks'));
    idle.sort((a, b) => sums[b].last.date < sums[a].last.date ? -1 : 1).forEach(n => row(n, d)); lc.appendChild(d);
  }
  const k = card(root, 'What the labels mean');
  ['pr', 'progressing', 'rebuilding', 'stalled'].forEach(s => { const r = el('div', 'exrow'); r.appendChild(el('div', 'chip ' + STATUS[s][1], STATUS[s][0])); r.appendChild(el('div', 'muted small', STATUS_NOTE[s])); k.appendChild(r); });
}
function statsVolume(root) {
  const weeks = C.weeklyStats(db, 8);
  const c = card(root, 'Hard sets per muscle, by week');
  const g = el('div', 'heat');
  g.appendChild(el('div', 'hh', ''));
  weeks.forEach((w, i) => g.appendChild(el('div', 'hh', (i === 0 || +w.start.slice(8) <= 7 ? (+w.start.slice(5, 7)) + '/' : '') + (+w.start.slice(8)))));
  g.appendChild(el('div', 'hh', '4wk'));
  MUSCLES.forEach(m => {
    g.appendChild(el('div', 'hl', MUSCLE_LABEL[m]));
    weeks.forEach(w => { const v = w.m[m]; g.appendChild(el('div', 'hc ' + (v === 0 ? 'z' : v < 8 ? 'lo' : v > 22 ? 'hi' : 'in'), v ? String(Math.round(v)) : '')); });
    const a = round1(weeks.slice(-4).reduce((n, w) => n + w.m[m], 0) / 4);
    g.appendChild(el('div', 'hc avg ' + (a < 8 ? 'lo' : a > 22 ? 'hi' : 'in'), String(a)));
  });
  g.appendChild(el('div', 'hl', 'Sessions'));
  weeks.forEach(w => g.appendChild(el('div', 'hc ses', w.sessions ? String(w.sessions) : '')));
  g.appendChild(el('div', 'hc ses', String(round1(weeks.slice(-4).reduce((n, w) => n + w.sessions, 0) / 4))));
  c.appendChild(g);
  c.appendChild(el('div', 'muted tiny-note', 'Each column is a week, labelled by its Monday. The last column is the 4-week average.'));
  const lg = el('div', 'legend');
  [['in', '8 to 22: growth range'], ['lo', 'under 8: maintenance at best'], ['hi', 'over 22: more than you can recover from']].forEach(([k, t]) => { const i = el('span', 'lg'); i.appendChild(el('i', 'sq hc ' + k)); i.appendChild(document.createTextNode(t)); lg.appendChild(i); });
  c.appendChild(lg);
  c.appendChild(el('div', 'muted small', 'A hard set is a working set (warm-ups excluded). Compounds credit half a set to the muscles that assist. Target 10 to 20 a week per muscle.'));
}
function statsBody(root) {
  const g = card(root, 'Body composition');
  const scans = (db.scans || []).slice().sort(byDateAsc), tgt = (db.profile && db.profile.target) || {};
  const F = scans[0], L = scans[scans.length - 1];
  if (L) {
    const goal = (label, from, now, to, unitTxt) => {
      if (from === undefined || to === undefined) return;
      const frac = Math.max(0, Math.min(1, (now - from) / (to - from || 1)));
      const w = el('div', 'goal');
      const top = el('div', 'grow'); top.appendChild(el('div', 'exname', label)); top.appendChild(el('div', 'right', now + unitTxt)); w.appendChild(top);
      const t = el('div', 'btrack'), f = el('div', 'bfill'); f.style.width = Math.round(frac * 100) + '%'; t.appendChild(f); w.appendChild(t);
      const b = el('div', 'grow muted tiny-note'); b.appendChild(el('div', '', 'start ' + from + unitTxt)); b.appendChild(el('div', 'right', Math.round(frac * 100) + '% of the way · target ' + to + unitTxt)); w.appendChild(b);
      g.appendChild(w);
    };
    goal('Body fat', F.body_fat_pct, L.body_fat_pct, tgt.body_fat_pct, '%');
    goal('Lean mass', F.lean_mass_lb, L.lean_mass_lb, tgt.lean_mass_lb, ' lb');
    const due = addDays(L.date, 90), late = daysAgo(due);
    g.appendChild(el('div', late > 0 ? 'note' : 'muted small', scans.length === 1
      ? 'Only the baseline scan from ' + fmtDate(L.date) + ' so far, so there is nothing to compare yet. ' + (late > 0 ? 'The retest was due ' + fmtDate(due) + ', ' + late + ' days ago.' : 'Retest around ' + fmtDate(due) + '.')
      : scans.length + ' scans. Latest ' + fmtDate(L.date) + '. ' + (late > 0 ? 'Next retest is ' + late + ' days overdue.' : 'Next retest around ' + fmtDate(due) + '.')));
    if (scans.length > 1) {
      g.appendChild(lineChart(scans.map(x => ({ date: x.date, y: x.lean_mass_lb, label: x.body_fat_pct + '% fat' })), { height: 140, label: 'Lean mass by scan' }));
      g.appendChild(el('div', 'muted tiny-note', 'Lean mass (lb) at each scan.'));
    }
  } else g.appendChild(el('div', 'muted small', 'No scans yet.'));
  g.appendChild(btn('', '＋ Add a scan', () => go('settings')));

  const b = card(root, 'Bodyweight');
  const bw = (db.bodyweight || []).slice().sort(byDateAsc);
  if (bw.length) {
    const last7 = bw.filter(x => daysAgo(x.date) <= 7), src = last7.length ? last7 : bw.slice(-1);
    b.appendChild(el('div', 'big-num', round1(src.reduce((s, x) => s + x.w, 0) / src.length) + ' ' + unit()));
    b.appendChild(el('div', 'muted small', (last7.length ? '7-day average' : 'latest, ' + fmtDate(src[0].date)) + ' · ' + bw.length + ' entries'));
    if (bw.length >= 3) b.appendChild(lineChart(bw.map(x => ({ date: x.date, y: x.w, label: x.w + ' ' + unit() })), { height: 130, label: 'Bodyweight' }));
  } else b.appendChild(el('div', 'muted small', 'Nothing logged. A recomp should hold the scale nearly flat, so a weekly weigh-in is the cheapest check between scans, and it makes pull-up numbers honest.'));
  b.appendChild(bodyweightRow());
}
function bodyweightRow() {
  const row = el('div', 'inrow');
  const bi = el('input'); bi.type = 'text'; bi.inputMode = 'decimal'; bi.placeholder = 'Bodyweight today (' + unit() + ')';
  row.appendChild(bi);
  row.appendChild(btn('', 'Log', () => {
    const v = parseFloat(bi.value); if (!v) return;
    db.bodyweight = (db.bodyweight || []).filter(x => x.date !== today());
    db.bodyweight.push({ date: today(), w: v }); db.bodyweight.sort(byDateAsc);
    bi.value = ''; save(true); toast('Bodyweight logged'); if (route.startsWith('stats')) render();
  }));
  return row;
}
function tile(root, label, value, sub) {
  const t = el('div', 'tile'); t.appendChild(el('div', 'tlabel', label)); t.appendChild(el('div', 'tval', value));
  if (sub) t.appendChild(el('div', 'muted tiny-note', sub)); root.appendChild(t); return t;
}
/* sessions per week as bars, with the plan as a line */
function weekBars(weeks, target) {
  const wrap = el('div', 'chart');
  const W = Math.max(280, Math.min(600, (document.querySelector('#main') || {}).clientWidth - 52 || 320)), H = 118, pad = { l: 6, r: 6, t: 14, b: 20 };
  const s = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Sessions per week' });
  const max = Math.max(target, ...weeks.map(w => w.sessions)), bw = (W - pad.l - pad.r) / weeks.length;
  const Y = v => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  weeks.forEach((w, i) => {
    const x = pad.l + i * bw + 2, h = Math.max(2, H - pad.b - Y(w.sessions));
    s.appendChild(sv('rect', { x, y: H - pad.b - h, width: Math.max(3, bw - 4), height: h, rx: 3, fill: w.sessions >= target ? 'var(--accent)' : w.sessions ? 'var(--accent-dim)' : 'var(--bad)', opacity: w.sessions ? 1 : 0.55 }));
    if (w.sessions) { const t = sv('text', { x: x + (bw - 4) / 2, y: H - pad.b - h - 3, 'text-anchor': 'middle', class: 'axis' }); t.textContent = w.sessions; s.appendChild(t); }
    const lastW = i === weeks.length - 1, monthStart = w.start.slice(8) <= '07' && i > 2 && i < weeks.length - 3;
    if (i === 0 || lastW || monthStart) {
      const t = sv('text', { x: lastW ? W - pad.r : x, y: H - 5, 'text-anchor': lastW ? 'end' : 'start', class: 'axis' });
      t.textContent = lastW ? 'this week' : fmtDate(w.start); s.appendChild(t);
    }
  });
  s.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: Y(target), y2: Y(target), stroke: 'var(--fg)', 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.5 }));
  wrap.appendChild(s); return wrap;
}

/* --- charts (inline SVG, single series, no library) --- */
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach(k => n.setAttribute(k, attrs[k])); return n; };
function sparkline(vals) {
  const W = 64, H = 24, s = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'spark', 'aria-hidden': 'true' });
  if (vals.length < 2) return s;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pts = vals.map((v, i) => [2 + i * (W - 6) / (vals.length - 1), H - 3 - (v - lo) / span * (H - 6)]);
  s.appendChild(sv('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const e = pts[pts.length - 1];
  s.appendChild(sv('circle', { cx: e[0], cy: e[1], r: 2.5, fill: 'var(--accent)' }));
  return s;
}
function niceTicks(lo, hi, n) {
  const span = hi - lo || Math.abs(hi) || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
/* points: [{date, y, label, pr}] oldest first. Time on x, so gaps between sessions read honestly. */
function lineChart(points, opts) {
  opts = opts || {};
  const wrap = el('div', 'chart');
  const W = Math.max(280, Math.min(600, (document.querySelector('#main') || {}).clientWidth - 52 || 320)), H = opts.height || 190;
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const T = d => new Date(d + 'T00:00:00').getTime();
  const t0 = T(points[0].date), t1 = T(points[points.length - 1].date);
  const tspan = Math.max(t1 - t0, 86400000 * 7);
  const extra = (opts.extra || []).filter(e => e.points.length > 1);
  const ys = points.map(p => p.y).concat(...extra.map(e => e.points.map(p => p.y))), ticks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const ylo = ticks[0], yhi = ticks[ticks.length - 1] === ylo ? ylo + 1 : ticks[ticks.length - 1];
  const X = p => pad.l + (new Date(p.date + 'T00:00:00').getTime() - t0) / tspan * (W - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - ylo) / (yhi - ylo)) * (H - pad.t - pad.b);
  const s = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'trend chart' });
  (opts.bands || []).forEach(b => {                       // breaks in training, shaded so dips read honestly
    const x1 = Math.max(pad.l, X({ date: b.from })), x2 = Math.min(W - pad.r, X({ date: b.to }));
    if (x2 > x1) s.appendChild(sv('rect', { x: x1, y: pad.t, width: x2 - x1, height: H - pad.t - pad.b, fill: 'var(--band)' }));
  });
  ticks.forEach(v => {
    s.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = sv('text', { x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }); tx.textContent = v.toLocaleString(); s.appendChild(tx);
  });
  [points[0], points[points.length - 1]].forEach((p, i) => {
    if (i === 1 && points.length === 1) return;
    const tx = sv('text', { x: X(p), y: H - 6, 'text-anchor': i ? 'end' : 'start', class: 'axis' }); tx.textContent = fmtDate(p.date); s.appendChild(tx);
  });
  const xy = points.map(p => [X(p), Y(p.y)]);
  extra.forEach(e => s.appendChild(sv('polyline', { points: e.points.map(p => X(p) + ',' + Y(p.y)).join(' '), fill: 'none', stroke: e.color, 'stroke-width': 1.5, 'stroke-linejoin': 'round', opacity: 0.9 })));
  if (points.length > 1) {
    s.appendChild(sv('path', { d: 'M' + xy.map(q => q.join(',')).join('L') + `L${xy[xy.length - 1][0]},${Y(ylo)}L${xy[0][0]},${Y(ylo)}Z`, fill: 'var(--accent)', opacity: 0.1 }));
    s.appendChild(sv('polyline', { points: xy.map(q => q.join(',')).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  const dot = points.length > 18 ? 0.6 : 1;
  if (opts.dots !== false) points.forEach((p, i) => s.appendChild(sv('circle', { cx: xy[i][0], cy: xy[i][1], r: (p.pr ? 5 : 4) * dot, fill: p.pr ? 'var(--accent)' : 'var(--card)', stroke: p.pr ? 'var(--card)' : 'var(--accent)', 'stroke-width': 2 })));
  const lastP = points[points.length - 1], lt = sv('text', { x: xy[xy.length - 1][0] - 8, y: xy[xy.length - 1][1] - 12, 'text-anchor': 'end', class: 'vlabel' });
  lt.textContent = lastP.y; if (opts.dots !== false) s.appendChild(lt);
  // crosshair + tooltip: snaps to the nearest session
  const cross = sv('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  s.appendChild(cross);
  const tip = el('div', 'tip');
  const move = ev => {
    const rect = s.getBoundingClientRect(); const x = (ev.clientX - rect.left) * (W / rect.width);
    let bi = 0; xy.forEach((q, i) => { if (Math.abs(q[0] - x) < Math.abs(xy[bi][0] - x)) bi = i; });
    cross.setAttribute('x1', xy[bi][0]); cross.setAttribute('x2', xy[bi][0]); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = ''; tip.appendChild(el('strong', '', String(points[bi].y))); tip.appendChild(el('span', '', ' ' + fmtDate(points[bi].date) + (points[bi].label ? ' · ' + points[bi].label : '') + (points[bi].pr ? ' · PR' : '')));
    tip.style.display = 'block';
    const px = xy[bi][0] / W * rect.width; tip.style.left = Math.max(0, Math.min(rect.width - 170, px - 85)) + 'px';
  };
  s.addEventListener('pointermove', move); s.addEventListener('pointerdown', move);
  s.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
  wrap.appendChild(s); wrap.appendChild(tip);
  return wrap;
}

let liftMetric = 'e1';
/* --- LIFT DETAIL --- */
function viewLift(root, name) {
  const series = liftSeries(db), S = series[name];
  root.appendChild(btn('ghost back', '‹ Lifts', () => go('stats:lifts')));
  if (!S) { card(root, null).textContent = 'No working sets logged for ' + name + ' yet.'; return; }
  const info = exInfo(name, db), sum = liftSummary(S, today(), { blockStart: C.blockStart(db) });
  const h = card(root, (info.known ? KIND_LABEL[info.kind] + ' · ' + info.pattern : 'Not in library'));
  h.appendChild(el('h2', '', name));
  const sl = el('div', 'statusline'); sl.appendChild(statusChip(sum)); sl.appendChild(el('span', 'muted small', STATUS_NOTE[sum.status] || '')); h.appendChild(sl);
  const grid = el('div', 'tiles');
  tile(grid, 'Latest e1RM', sum.last.best + ' ' + unit(), sum.pct === 100 ? 'your best' : sum.pct + '% of your best');
  tile(grid, 'Best e1RM', sum.best + ' ' + unit(), fmtDate(sum.bestDate));
  tile(grid, 'Since first', (sum.change >= 0 ? '+' : '') + sum.change + ' ' + unit(), sum.changePct !== null ? (sum.changePct >= 0 ? '+' : '') + sum.changePct + '% over ' + sum.sessions + ' sessions' : '');
  tile(grid, '8-week trend', sum.trend === null ? 'n/a' : (sum.trend >= 0 ? '+' : '') + sum.trend + '%', 'per 4 weeks');
  h.appendChild(grid);
  const prSet = new Set(sum.prIdx);
  const metrics = {
    e1: ['Est. 1RM', p => p.best, 'Estimated 1RM per session'],
    top: ['Top set', p => p.top.w, 'Heaviest working set, ' + (LOAD_NOTE[info.load] || unit())],
    vol: ['Volume', p => Math.round(p.sets.reduce((n, x) => n + (x.warm ? 0 : (x.eff || 0) * (x.r || 0)), 0)), 'Load × reps across working sets']
  };
  const mk = metrics[liftMetric] ? liftMetric : 'e1';
  const seg = el('div', 'seg small'); Object.keys(metrics).forEach(k => seg.appendChild(btn(k === mk ? 'on' : '', metrics[k][0], () => { liftMetric = k; render(); }))); h.appendChild(seg);
  h.appendChild(el('div', 'muted tiny-note', metrics[mk][2]));
  h.appendChild(lineChart(S.map((p, i) => ({ date: p.date, y: metrics[mk][1](p), label: setStr(p.top, info), pr: mk === 'e1' && prSet.has(i) })), { label: name + ' over time', bands: C.layoffs(db) }));
  h.appendChild(el('div', 'muted tiny-note', (mk === 'e1' ? 'Filled dots are PRs. ' : '') + 'Shaded bands are breaks of 10+ days. Warm-ups excluded.'));

  // what has to happen next, by the double-progression rule in COACH.md
  const tg = sum.target;
  if (tg && tg.hi && sum.status !== 'idle') {
    const nx = card(root, 'Next step');
    const bump = info.kind === 'lc' ? 10 : 5, u = unit() === 'kg' ? bump / 2 : bump;
    const sets = sum.last.sets.filter(x => !x.warm && x.r > 0);
    nx.appendChild(el('div', 'small', 'Last time, ' + fmtDate(sum.last.date) + ': ' + sets.map(x => setStr(x, info)).join(', ') + ' against a target of ' + (tg.sets || sets.length) + '×' + (tg.lo === tg.hi ? tg.hi : tg.lo + '-' + tg.hi) + '.'));
    const dots = el('div', 'dots'); sets.forEach(x => dots.appendChild(el('i', x.r >= tg.hi ? 'on' : x.r < tg.lo ? 'miss' : ''))); nx.appendChild(dots);
    nx.appendChild(el('div', 'muted small', sum.hitTop ? 'Every set reached ' + tg.hi + '. Add about ' + u + ' ' + unit() + ' next time and start again from ' + tg.lo + ' reps.'
      : sum.topHits + ' of ' + sets.length + ' sets reached ' + tg.hi + ' reps. Keep the weight, add reps until every set does, then add about ' + u + ' ' + unit() + '.'));
  }

  const t = card(root, 'Sessions');
  S.slice().reverse().forEach((p, ri) => {
    const i = S.length - 1 - ri;
    const r = el('div', 'exrow');
    const l = el('div', ''); l.appendChild(el('div', 'small', fmtDate(p.date) + (prSet.has(i) ? '  ★' : '')));
    l.appendChild(el('div', 'muted tiny-note', p.target || ''));
    r.appendChild(l);
    const setsTxt = p.sets.map(s => (s.warm ? '(' : '') + setStr(s, info) + (s.warm ? ')' : '')).join(' ');
    const rr = el('div', 'right'); rr.appendChild(el('div', 'small', setsTxt)); rr.appendChild(el('div', 'muted tiny-note', 'e1RM ' + p.best + (p.raw !== name ? ' · as ' + p.raw : '')));
    r.appendChild(rr);
    r.onclick = () => go('session:' + p.sid);
    t.appendChild(r);
  });

  if (sum.repPRs.length) {
    const rp = card(root, 'Best reps at each weight');
    sum.repPRs.slice(0, 8).forEach(x => {
      const r = el('div', 'exrow'); r.appendChild(el('div', 'small', setStr({ w: x.w, r: x.r }, info).replace(/×\d+$/, '') + ' ' + (info.load === 'bw' || info.load === 'assisted' ? '' : unit())));
      r.appendChild(el('div', 'muted small right', x.r + ' reps · ' + fmtDate(x.date))); rp.appendChild(r);
    });
  }

  const m = card(root, 'Name & tracking');
  const aliases = [...new Set(S.map(p => p.raw).filter(r => r !== name))];
  const userAliasesIn = Object.keys(db.aliases || {}).filter(k => db.aliases[k] === name && k !== name);
  if (aliases.length || userAliasesIn.length) m.appendChild(el('div', 'muted small', 'Also logged as: ' + [...new Set([...aliases, ...userAliasesIn])].join(', ')));
  userAliasesIn.forEach(k => m.appendChild(btn('tiny', 'Unmerge ' + k, () => { delete db.aliases[k]; save(true); render(); })));
  m.appendChild(btn('', 'Merge into another lift…', () => pickExerciseSheet('Merge "' + name + '" into', target => {
    const to = canon(target, db);
    if (to === name) return;
    if (!confirm('Treat every "' + name + '" set as "' + to + '"? Your raw log keeps the original name, and you can unmerge later.')) return;
    db.aliases = db.aliases || {};
    Object.keys(db.aliases).forEach(k => { if (db.aliases[k] === name) db.aliases[k] = to; });
    db.aliases[name] = to; save(true); go('lift:' + to);
  }, name)));
  if (!C.CATALOG[name]) {
    m.appendChild(el('div', 'kicker spaced', 'Classify (for muscle set counts)'));
    const cur = db.exercises[name] || {};
    const ms = el('select'); ms.appendChild(el('option', '', 'Primary muscle…'));
    MUSCLES.forEach(k => { const o = el('option', '', MUSCLE_LABEL[k]); o.value = k; if (cur.m && cur.m[k] === 1) o.selected = true; ms.appendChild(o); });
    const ks = el('select'); [['iso', 'Isolation'], ['uc', 'Upper compound'], ['lc', 'Lower compound'], ['core', 'Core']].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; if (cur.kind === v) o.selected = true; ks.appendChild(o); });
    const ls = el('select'); Object.keys(LOAD_NOTE).forEach(v => { const o = el('option', '', v + ' (' + LOAD_NOTE[v] + ')'); o.value = v; if (cur.load === v) o.selected = true; ls.appendChild(o); });
    m.appendChild(ms); m.appendChild(ks); m.appendChild(ls);
    m.appendChild(btn('', 'Save', () => {
      if (!MUSCLES.includes(ms.value)) return toast('Pick a muscle');
      db.exercises[name] = Object.assign({}, cur, { m: { [ms.value]: 1 }, kind: ks.value, load: ls.value, pattern: cur.pattern || 'other' });
      save(true); render(); toast('Saved');
    }));
  }
  const ps = el('label', 'toggle'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = info.perSide;
  cb.onchange = () => { db.exercises[name] = Object.assign({}, db.exercises[name], { perSide: cb.checked }); save(true); };
  ps.appendChild(cb); ps.appendChild(el('span', '', 'I log each side as its own set (halves the set count)'));
  m.appendChild(ps);
}

/* --- SETTINGS --- */
function viewSettings(root) {
  const s = db.settings;
  const f = (c, label, key, type, ph) => {
    const w = el('div', 'field'); w.appendChild(el('label', '', label));
    const i = el('input'); i.type = type || 'text'; i.value = s[key] || ''; i.placeholder = ph || '';
    i.autocapitalize = 'off'; i.autocomplete = 'off'; i.spellcheck = false;
    i.onchange = () => { s[key] = i.value.trim(); save(); render(); };
    w.appendChild(i); c.appendChild(w);
  };
  const c = card(root, 'GitHub sync');
  f(c, 'Owner (your GitHub username)', 'owner', 'text', '00caesar00');
  f(c, 'Repo', 'repo', 'text', 'liftlog');
  f(c, 'Branch', 'branch', 'text', 'main');
  f(c, 'Fine-grained token (Contents: read & write)', 'token', 'password', 'github_pat_…');
  const u = el('div', 'field'); u.appendChild(el('label', '', 'Units'));
  const us = el('select');
  ['lb', 'kg'].forEach(x => { const o = el('option', '', x); o.value = x; if (s.unit === x) o.selected = true; us.appendChild(o); });
  us.onchange = () => { s.unit = us.value; save(true); render(); };
  u.appendChild(us); c.appendChild(u);
  c.appendChild(btn('primary', 'Sync now', () => syncNow()));
  c.appendChild(btn('', 'Restore from GitHub', restoreFromGitHub));
  c.appendChild(el('div', 'muted small', (db.lastSync ? 'Last sync ' + new Date(db.lastSync).toLocaleString() : 'Never synced') + (db.dirty ? ' · unsynced changes' : '')));
  if (db.lastSyncError && db.dirty) c.appendChild(el('div', 'muted tiny-note', 'Last error: ' + db.lastSyncError));

  const tm = card(root, 'Rest timer');
  const tog = (label, key, note, after) => {
    const w = el('label', 'toggle'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!s[key];
    cb.onchange = () => { s[key] = cb.checked; save(); if (after) after(cb.checked); };
    w.appendChild(cb); w.appendChild(el('span', '', label)); tm.appendChild(w);
    if (note) tm.appendChild(el('div', 'muted tiny-note', note));
  };
  tog('Show the timer on the lock screen', 'lockTimer', 'Uses the iPhone Now Playing card: time left, a progress bar, what is next, and three beeps at zero, even with the phone locked. Trade-off: it takes over audio, so music playing from this phone pauses when a rest starts. On the lock screen, next-track skips the rest and previous-track adds 30 s.', on => { if (!on) LockTimer.stop(); });
  tog('Open the full-screen timer after every set', 'bigTimer', 'Otherwise tap the timer bar to open it.');
  tm.appendChild(btn('', 'Try a 20 s rest now', () => { startRest(20, 'Test: lock the phone now'); toast('Timer started. Lock the phone to check.'); }));

  const k = card(root, 'Coach in the app (optional)');
  k.appendChild(el('div', 'muted small', 'With a Claude API key, the Today tab gets an "Ask the coach" button that writes the plan straight into the app. Get a key at platform.claude.com. It is stored only on this phone.'));
  f(k, 'Claude API key', 'apiKey', 'password', 'sk-ant-…');
  f(k, 'Model', 'model', 'text', 'claude-sonnet-5');

  const sc = card(root, 'Body composition scans');
  (db.scans || []).slice().sort(byDateDesc).forEach(x => {
    const r = el('div', 'exrow'); r.appendChild(el('div', 'small', fmtDate(x.date) + ' · ' + (x.source || 'scan')));
    r.appendChild(el('div', 'muted small right', x.body_fat_pct + '% · ' + x.lean_mass_lb + ' lb lean'));
    sc.appendChild(r);
  });
  const det = el('details'); det.appendChild(el('summary', 'small', '＋ Add a scan'));
  const vals = { date: today() };
  const fld = (label, key, type) => { const w = el('div', 'field'); w.appendChild(el('label', '', label)); const i = el('input'); i.type = type || 'text'; if (type !== 'date') i.inputMode = 'decimal'; i.value = vals[key] || ''; i.onchange = () => vals[key] = type === 'date' ? i.value : parseFloat(i.value); w.appendChild(i); det.appendChild(w); };
  fld('Date', 'date', 'date'); fld('Body fat %', 'body_fat_pct'); fld('Lean mass (lb)', 'lean_mass_lb'); fld('Fat mass (lb)', 'fat_mass_lb');
  fld('Total mass (lb)', 'total_mass_lb'); fld('Visceral fat (lb)', 'visceral_fat_lb'); fld('A/G ratio', 'ag_ratio'); fld('ALMI', 'almi'); fld('FFMI', 'ffmi');
  det.appendChild(btn('primary', 'Save scan', () => {
    if (!vals.date || !vals.body_fat_pct || !vals.lean_mass_lb) return toast('Date, body fat % and lean mass are required');
    const rec = { source: 'DXA' }; Object.keys(vals).forEach(k2 => { if (vals[k2] !== undefined && !(typeof vals[k2] === 'number' && isNaN(vals[k2]))) rec[k2] = vals[k2]; });
    db.scans = (db.scans || []).filter(x => x.date !== rec.date).concat([rec]).sort(byDateAsc);
    save(true); render(); toast('Scan saved');
  }));
  sc.appendChild(det);

  const d = card(root, 'Data');
  d.appendChild(btn('', 'Copy digest (what the coach sees)', () => { navigator.clipboard.writeText(JSON.stringify(buildDigest(db))); toast('Digest copied'); }));
  d.appendChild(btn('', 'Download full backup', () => {
    const blob = new Blob([JSON.stringify(Object.assign({}, db, { settings: Object.assign({}, db.settings, { token: '', apiKey: '' }) }), null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'liftlog-backup-' + today() + '.json'; a.click();
  }));
  d.appendChild(btn('ghost', 'Reset local data', () => {
    if (confirm('Erase local data on this phone? Synced data in GitHub is kept.')) { localStorage.removeItem(KEY); localStorage.removeItem(KEY_V1); db = load(); render(); }
  }));
  d.appendChild(el('div', 'muted tiny-note', 'Data format v' + db.v + (db.migrated && db.migrated.from1 ? ' · upgraded from v1 on ' + new Date(db.migrated.from1).toLocaleDateString() : '')));

  const p = card(root, 'Program (JSON)');
  const ta = el('textarea'); ta.rows = 6; ta.value = db.program ? JSON.stringify(db.program) : '';
  ta.onchange = () => { try { db.program = JSON.parse(ta.value); save(true); toast('Program saved'); } catch (e) { toast('Invalid JSON'); } };
  p.appendChild(ta);
}

/* ---------------- boot ---------------- */
let renderedDay = '';
function handleHash() {
  const h = location.hash || '';
  if (h.startsWith('#plan=') || h.startsWith('#t=')) {
    try { db.plan = C.parseAnyPlan(location.href); history.replaceState(null, '', location.pathname); save(true); route = 'today'; toast('Plan loaded from coach'); }
    catch (e) { toast('Bad plan link'); }
  }
}
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.addEventListener) {
  window.addEventListener('hashchange', () => { handleHash(); render(); });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(t.dataset.route));
    $('#restStop').onclick = ev => { ev.stopPropagation(); stopRest(); };
    $('#restPlus').onclick = ev => { ev.stopPropagation(); addRest(30); };
    $('#rest').onclick = openRestFull;
    $('#rfPlus').onclick = () => addRest(30);
    $('#rfSkip').onclick = stopRest;
    $('#rfClose').onclick = closeRestFull;
    $('#syncdot').onclick = () => syncNow();
    if (!db.program) {
      fetch('data/program.json').then(r => r.ok ? r.json() : null).then(j => { if (j) { db.program = j; save(); render(); } }).catch(() => {});
    }
    save();                         // persists the v2 copy under the new key on first run
    autoFinishStale(); handleHash();
    // iOS often reloads a home-screen app after a lock. Put the user back where they were.
    const wh = uiState.where, fresh = wh && Date.now() - wh.at < (db.active ? 3 * 3600000 : 15 * 60000);
    if (fresh && !location.hash) route = wh.route;
    render(); renderedDay = today();
    if (fresh && route === wh.route) window.scrollTo(0, wh.y || 0);
    if (!db.active) { uiState.drafts = {}; uiState.open = {}; saveUi(); }
    if (uiState.rest) tickRest();
    if (db.active) wake(true);
    setInterval(paintActiveMeta, 30000);
    window.addEventListener('online', () => { if (db.dirty) syncNow(true); });
    const remember = () => { uiState.where = { route, y: window.scrollY || 0, at: Date.now() }; saveUi(); };
    window.addEventListener('pagehide', remember);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { remember(); if (db.dirty && GH.ok()) syncNow(true); return; }
      // Coming back: only redraw if something actually changed, so nothing typed or dialled in is lost.
      const had = !!db.active; autoFinishStale();
      if (db.active) wake(true);
      if (had !== !!db.active || renderedDay !== today()) { render(); renderedDay = today(); }
      paintActiveMeta(); paintRest();
    });
    if (db.dirty) scheduleSync();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* export for headless tests */
if (typeof module !== 'undefined' && module.exports) module.exports = { GH, v1BackupEntries, syncNow, restoreFromGitHub, askCoach, LockTimer, _db: () => db, _setDb: d => db = d };
