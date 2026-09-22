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
  if (syncing) return syncing;
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
        messages: [{ role: 'user', content: 'Digest (liftlog/2):\n```json\n' + JSON.stringify(buildDigest(db)) +
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
const ui = { open: {}, sheet: null };
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
  ui.open = {};
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
    db.active = null; save(true); render(); return;
  }
  db.sessions.push(a); db.active = null; wake(false);
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

/* ---------------- rest timer + wake lock ---------------- */
let restEnd = 0, restInt = null, wakeLock = null;
function startRest(sec) {
  restEnd = Date.now() + sec * 1000;
  if (restInt) clearInterval(restInt);
  restInt = setInterval(paintRest, 250); paintRest();
}
function paintRest() {
  const bar = $('#rest'); const left = Math.round((restEnd - Date.now()) / 1000);
  if (left <= 0) { bar.classList.remove('show'); clearInterval(restInt); restInt = null; if (restEnd) beep(); restEnd = 0; return; }
  bar.classList.add('show');
  $('#restTime').textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}
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
function pickExerciseSheet(title, onPick, exclude) {
  openSheet(sh => {
    sh.appendChild(el('div', 'kicker', title));
    const inp = el('input'); inp.placeholder = 'Search or type a new name'; sh.appendChild(inp);
    const list = el('div', 'picklist'); sh.appendChild(list);
    const names = [...new Set([...Object.keys(C.CATALOG), ...Object.keys(liftSeries(db)), ...Object.keys(db.exercises || {})])]
      .filter(n => n !== exclude).sort();
    const paint = () => {
      list.innerHTML = ''; const q = inp.value.trim().toLowerCase();
      const hits = names.filter(n => !q || n.toLowerCase().includes(q)).slice(0, 40);
      if (q && !names.some(n => n.toLowerCase() === q)) hits.unshift('＋ ' + inp.value.trim());
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
  nta.onchange = () => { db.coachNotes = nta.value; save(true); };
  nc.appendChild(nta);

  const bc = card(root, null, 'row');
  const bi = el('input'); bi.type = 'text'; bi.inputMode = 'decimal'; bi.placeholder = 'Bodyweight (' + unit() + ')';
  bc.appendChild(bi);
  bc.appendChild(btn('', 'Log', () => {
    const v = parseFloat(bi.value); if (!v) return;
    db.bodyweight = (db.bodyweight || []).filter(x => x.date !== today());
    db.bodyweight.push({ date: today(), w: v }); db.bodyweight.sort(byDateAsc);
    bi.value = ''; save(true); toast('Bodyweight logged');
  }));
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
  const mins = Math.round((Date.now() - new Date(a.start).getTime()) / 60000);
  head.appendChild(el('div', 'muted small', mins + ' min · ' + countSets(a) + ' sets · volume ' + sessionVolume(a, db).toLocaleString() + ' ' + unit()));

  a.ex.forEach((e, ei) => {
    const info = exInfo(e.name, db), t = parseTarget(e.target);
    const done = (e.sets || []).length, workDone = C.warmupFlags(e.sets, info).filter(w => !w).length;
    const complete = t.sets && workDone >= t.sets;
    const key = ei + ':' + e.name;
    const open = ui.open[key] !== undefined ? ui.open[key] : !complete;
    const c = card(root, null, complete ? 'done' : '');
    const top = el('div', 'exhead');
    const l = el('div', ''); l.onclick = () => { ui.open[key] = !open; render(); };
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
  ta.onchange = () => { a.notes = ta.value; save(true); };
  nc.appendChild(ta);

  const fin = card(root, null);
  fin.appendChild(btn('primary big', 'Finish & sync', () => finishSession(false)));
  fin.appendChild(btn('ghost', 'Discard session', () => { if (confirm('Discard this session?')) { db.active = null; wake(false); save(true); render(); } }));
}
function exerciseMenu(a, ei) {
  const e = a.ex[ei];
  openSheet(sh => {
    sh.appendChild(el('div', 'kicker', exInfo(e.name, db).name));
    sh.appendChild(btn('big', 'Swap for another exercise', () => pickExerciseSheet('Swap ' + e.name + ' for', n => {
      const from = e.name; e.name = canon(n, db);
      a.notes = (a.notes ? a.notes + ' ' : '') + '[swapped ' + from + ' → ' + e.name + ']';
      save(true); render();
    }, e.name)));
    if (ei > 0) sh.appendChild(btn('big', 'Move up', () => { a.ex.splice(ei - 1, 0, a.ex.splice(ei, 1)[0]); closeSheet(); save(true); render(); }));
    sh.appendChild(btn('big', 'Remove from session', () => { if (confirm('Remove ' + e.name + '?')) { a.ex.splice(ei, 1); closeSheet(); save(true); render(); } }));
    sh.appendChild(btn('ghost', 'Cancel', closeSheet));
  });
}
/* the fast set-entry widget */
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
  const box = el('div', 'entry');
  box.appendChild(numField(info.load === 'assisted' ? 'Assist' : info.load === 'bw' ? 'Added' : 'Weight', w, info.step, v => w = v, { min: 0 }));
  box.appendChild(numField('Reps', r, 1, v => r = v, { min: 0 }));
  box.appendChild(numField('RIR', rir, 1, v => rir = v, { min: 0 }));
  const wb = btn('warmbtn', 'Warm-up', () => { warm = !warm; wb.classList.toggle('on', warm); });
  box.appendChild(wb);
  box.appendChild(btn('primary logbtn', 'Log set', () => {
    if (!r) return;
    const best = warm ? 0 : bestEver(e.name, db.active.id);
    e.sets.push({ w, r, rir, t: warm ? 'w' : 'n', at: new Date().toISOString() });
    save(true); startRest(warm ? 60 : restFor(e)); render();
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

/* --- STATS --- */
function viewStats(root) {
  const series = liftSeries(db);
  const names = Object.keys(series);
  const lc = card(root, 'Lifts · latest e1RM · tap for history');
  if (!names.length) lc.appendChild(el('div', 'muted', 'No lifts logged yet.'));
  const groups = {};
  names.forEach(n => { const k = exInfo(n, db).known ? exInfo(n, db).kind : '?'; (groups[k] = groups[k] || []).push(n); });
  ['lc', 'uc', 'iso', 'core', '?'].forEach(k => {
    if (!groups[k]) return;
    lc.appendChild(el('div', 'group', KIND_LABEL[k]));
    groups[k].sort((a, b) => series[b].length - series[a].length || a.localeCompare(b)).forEach(n => {
      const S = series[n], sum = liftSummary(S);
      const r = el('div', 'liftrow'); r.onclick = () => go('lift:' + n);
      const l = el('div', 'lname'); l.appendChild(el('div', 'exname small', n));
      l.appendChild(el('div', 'muted tiny-note', S.length + ' session' + (S.length > 1 ? 's' : '') + ' · last ' + fmtDate(sum.last.date)));
      r.appendChild(l);
      r.appendChild(sparkline(S.slice(-10).map(p => p.best)));
      const v = el('div', 'lval'); v.appendChild(el('div', 'num', String(Math.round(sum.last.best))));
      v.appendChild(trendChip(sum));
      r.appendChild(v);
      lc.appendChild(r);
    });
  });

  const last28 = db.sessions.filter(s => daysAgo(s.date) <= 28);
  const wk = hardSetsByMuscle(last28, db);
  const c = card(root, 'Weekly hard sets (28-day average, warm-ups excluded)');
  MUSCLES.forEach(m => {
    const v = round1(wk[m] / 4);
    const row = el('div', 'bar');
    row.appendChild(el('div', 'blabel', MUSCLE_LABEL[m]));
    const track = el('div', 'btrack'); const fill = el('div', 'bfill'); fill.style.width = Math.min(100, v / 20 * 100) + '%';
    if (v < 8) fill.classList.add('low'); else if (v > 22) fill.classList.add('high');
    track.appendChild(fill); row.appendChild(track);
    row.appendChild(el('div', 'bval', String(v)));
    c.appendChild(row);
  });
  c.appendChild(el('div', 'muted small', 'Target band for growth: roughly 10-20 hard sets per muscle per week.'));

  const bw = (db.bodyweight || []).slice().sort(byDateAsc);
  if (bw.length) {
    const b = card(root, 'Bodyweight');
    const last7 = bw.filter(x => daysAgo(x.date) <= 7);
    const src = last7.length ? last7 : bw.slice(-1);
    b.appendChild(el('div', 'big-num', round1(src.reduce((s, x) => s + x.w, 0) / src.length) + ' ' + unit()));
    b.appendChild(el('div', 'muted small', (last7.length ? '7-day average' : 'latest') + ' · ' + bw.length + ' entries'));
    if (bw.length >= 3) b.appendChild(lineChart(bw.map(x => ({ date: x.date, y: x.w, label: x.w + ' ' + unit() })), { height: 130 }));
  }

  const g = card(root, 'Body composition');
  const scans = (db.scans || []).slice().sort(byDateAsc), tgt = db.profile.target || {};
  const L = scans[scans.length - 1];
  if (L) {
    const grid = el('div', 'tiles');
    tile(grid, 'Body fat', L.body_fat_pct + '%', tgt.body_fat_pct ? 'target ' + tgt.body_fat_pct + '%' : '');
    tile(grid, 'Lean mass', L.lean_mass_lb + ' lb', tgt.lean_mass_lb ? 'target ' + tgt.lean_mass_lb + ' lb' : '');
    if (scans.length > 1) {
      const F = scans[0];
      tile(grid, 'Since first scan', (L.lean_mass_lb - F.lean_mass_lb >= 0 ? '+' : '') + round1(L.lean_mass_lb - F.lean_mass_lb) + ' lb lean', round1(L.body_fat_pct - F.body_fat_pct) + ' pts body fat');
    }
    g.appendChild(grid);
    g.appendChild(el('div', 'muted small', 'Last scan ' + fmtDate(L.date) + ' · next retest around ' + fmtDate(addDays(L.date, 90))));
  }
  g.appendChild(btn('', '＋ Add a scan', () => go('settings')));
}
function trendChip(sum) {
  if (sum.stalled) return el('div', 'chip warn', '⏸ stalled');
  if (sum.trend === null) return el('div', 'chip', sum.sessions < 3 ? 'new' : '—');
  const up = sum.trend >= 0;
  return el('div', 'chip ' + (up ? 'ok' : 'down'), (up ? '▲ +' : '▼ ') + sum.trend + '%/4wk');
}
function tile(root, label, value, sub) {
  const t = el('div', 'tile'); t.appendChild(el('div', 'tlabel', label)); t.appendChild(el('div', 'tval', value));
  if (sub) t.appendChild(el('div', 'muted tiny-note', sub)); root.appendChild(t); return t;
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
  const t0 = new Date(points[0].date + 'T00:00:00').getTime(), t1 = new Date(points[points.length - 1].date + 'T00:00:00').getTime();
  const tspan = Math.max(t1 - t0, 86400000 * 7);
  const ys = points.map(p => p.y), ticks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const ylo = ticks[0], yhi = ticks[ticks.length - 1] === ylo ? ylo + 1 : ticks[ticks.length - 1];
  const X = p => pad.l + (new Date(p.date + 'T00:00:00').getTime() - t0) / tspan * (W - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - ylo) / (yhi - ylo)) * (H - pad.t - pad.b);
  const s = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'trend chart' });
  ticks.forEach(v => {
    s.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = sv('text', { x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }); tx.textContent = v.toLocaleString(); s.appendChild(tx);
  });
  [points[0], points[points.length - 1]].forEach((p, i) => {
    if (i === 1 && points.length === 1) return;
    const tx = sv('text', { x: X(p), y: H - 6, 'text-anchor': i ? 'end' : 'start', class: 'axis' }); tx.textContent = fmtDate(p.date); s.appendChild(tx);
  });
  const xy = points.map(p => [X(p), Y(p.y)]);
  if (points.length > 1) {
    s.appendChild(sv('path', { d: 'M' + xy.map(q => q.join(',')).join('L') + `L${xy[xy.length - 1][0]},${Y(ylo)}L${xy[0][0]},${Y(ylo)}Z`, fill: 'var(--accent)', opacity: 0.1 }));
    s.appendChild(sv('polyline', { points: xy.map(q => q.join(',')).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  points.forEach((p, i) => s.appendChild(sv('circle', { cx: xy[i][0], cy: xy[i][1], r: p.pr ? 5 : 4, fill: p.pr ? 'var(--accent)' : 'var(--card)', stroke: p.pr ? 'var(--card)' : 'var(--accent)', 'stroke-width': 2 })));
  const lastP = points[points.length - 1], lt = sv('text', { x: xy[xy.length - 1][0] - 8, y: xy[xy.length - 1][1] - 12, 'text-anchor': 'end', class: 'vlabel' });
  lt.textContent = lastP.y; s.appendChild(lt);
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

/* --- LIFT DETAIL --- */
function viewLift(root, name) {
  const series = liftSeries(db), S = series[name];
  root.appendChild(btn('ghost back', '‹ Stats', () => go('stats')));
  if (!S) { card(root, null).textContent = 'No working sets logged for ' + name + ' yet.'; return; }
  const info = exInfo(name, db), sum = liftSummary(S);
  const h = card(root, (info.known ? KIND_LABEL[info.kind] + ' · ' + info.pattern : 'Not in library'));
  h.appendChild(el('h2', '', name));
  const grid = el('div', 'tiles');
  tile(grid, 'Best e1RM', sum.best + ' ' + unit(), fmtDate(sum.bestDate));
  tile(grid, 'Since first', (sum.change >= 0 ? '+' : '') + sum.change + ' ' + unit(), sum.changePct !== null ? (sum.changePct >= 0 ? '+' : '') + sum.changePct + '% over ' + sum.sessions + ' sessions' : '');
  const tt = tile(grid, '8-week trend', sum.trend === null ? 'n/a' : (sum.trend >= 0 ? '+' : '') + sum.trend + '%', 'per 4 weeks');
  if (sum.stalled) tt.appendChild(el('div', 'chip warn', '⏸ stalled ' + sum.sinceBest + ' sessions'));
  tile(grid, 'Since last PR', sum.sinceBest === 0 ? 'PR last time' : sum.sinceBest + ' session' + (sum.sinceBest === 1 ? '' : 's'), sum.hitTop === true ? 'top of range hit last time' : sum.hitTop === false ? 'top of range not hit yet' : '');
  h.appendChild(grid);
  const prSet = new Set(sum.prIdx);
  h.appendChild(el('div', 'kicker spaced', 'Estimated 1RM per session'));
  h.appendChild(lineChart(S.map((p, i) => ({ date: p.date, y: p.best, label: setStr(p.top, info), pr: prSet.has(i) })), { label: name + ' e1RM over time' }));
  h.appendChild(el('div', 'muted tiny-note', 'Filled dots are PRs. Warm-ups excluded (shown in brackets below). Weight is ' + (LOAD_NOTE[info.load] || '') + '.'));

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
    $('#restStop').onclick = () => { restEnd = 0; paintRest(); };
    $('#restPlus').onclick = () => { restEnd += 30000; paintRest(); };
    $('#syncdot').onclick = () => syncNow();
    if (!db.program) {
      fetch('data/program.json').then(r => r.ok ? r.json() : null).then(j => { if (j) { db.program = j; save(); render(); } }).catch(() => {});
    }
    save();                         // persists the v2 copy under the new key on first run
    autoFinishStale(); handleHash(); render();
    if (db.active) wake(true);
    window.addEventListener('online', () => { if (db.dirty) syncNow(true); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { if (db.dirty && GH.ok()) syncNow(true); }
      else { autoFinishStale(); if (db.active) wake(true); render(); }
    });
    if (db.dirty) scheduleSync();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* export for headless tests */
if (typeof module !== 'undefined' && module.exports) module.exports = { GH, v1BackupEntries, syncNow, restoreFromGitHub, askCoach, _db: () => db, _setDb: d => db = d };
