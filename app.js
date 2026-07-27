/* LiftLog - personal training log. Local-first, syncs to a GitHub repo. */
'use strict';

/* ---------------- exercise library: name -> muscle set contributions ---------------- */
const EXLIB = {
  // push
  'Barbell Bench Press':        {chest:1, tri:0.5, delt:0.5},
  'Incline Barbell Bench':      {chest:1, tri:0.5, delt:0.5},
  'Incline Dumbbell Press':     {chest:1, tri:0.5, delt:0.5},
  'Flat Dumbbell Press':        {chest:1, tri:0.5, delt:0.5},
  'Machine Chest Press':        {chest:1, tri:0.5, delt:0.5},
  'Cable Fly':                  {chest:1},
  'Pec Deck':                   {chest:1},
  'Overhead Press':             {delt:1, tri:0.5},
  'Seated Dumbbell Press':      {delt:1, tri:0.5},
  'Lateral Raise':              {delt:1},
  'Cable Lateral Raise':        {delt:1},
  'Rear Delt Fly':              {delt:1, back:0.5},
  'Triceps Pushdown':           {tri:1},
  'Overhead Cable Extension':   {tri:1},
  'Skullcrusher':               {tri:1},
  'Dip':                        {chest:1, tri:1},
  // pull
  'Pull-Up':                    {back:1, bi:0.5},
  'Chin-Up':                    {back:1, bi:0.5},
  'Lat Pulldown':               {back:1, bi:0.5},
  'Chest-Supported Row':        {back:1, bi:0.5},
  'Barbell Row':                {back:1, bi:0.5},
  'Seated Cable Row':           {back:1, bi:0.5},
  'Single-Arm Dumbbell Row':    {back:1, bi:0.5},
  'Face Pull':                  {delt:1, back:0.5},
  'Barbell Curl':               {bi:1},
  'Incline Dumbbell Curl':      {bi:1},
  'Hammer Curl':                {bi:1},
  'Cable Curl':                 {bi:1},
  'Shrug':                      {back:1},
  // legs
  'Back Squat':                 {quad:1, glute:0.5},
  'Front Squat':                {quad:1, glute:0.5},
  'Hack Squat':                 {quad:1, glute:0.5},
  'Leg Press':                  {quad:1, glute:0.5},
  'Bulgarian Split Squat':      {quad:1, glute:1},
  'Walking Lunge':              {quad:1, glute:1},
  'Leg Extension':              {quad:1},
  'Romanian Deadlift':          {ham:1, glute:1},
  'Conventional Deadlift':      {ham:1, glute:1, back:0.5},
  'Trap Bar Deadlift':          {ham:1, glute:1, quad:0.5},
  'Seated Leg Curl':            {ham:1},
  'Lying Leg Curl':             {ham:1},
  'Hip Thrust':                 {glute:1, ham:0.5},
  'Back Extension':             {ham:1, glute:1},
  'Standing Calf Raise':        {calf:1},
  'Seated Calf Raise':          {calf:1},
  // core
  'Hanging Leg Raise':          {abs:1},
  'Cable Crunch':               {abs:1},
  'Ab Wheel':                   {abs:1},
  'Plank':                      {abs:1},
};
const MUSCLES = ['chest','back','delt','bi','tri','quad','ham','glute','calf','abs'];
const MUSCLE_LABEL = {chest:'Chest',back:'Back',delt:'Delts',bi:'Biceps',tri:'Triceps',quad:'Quads',ham:'Hams',glute:'Glutes',calf:'Calves',abs:'Abs'};

/* ---------------- pure helpers (also unit-tested headlessly) ---------------- */
function e1rm(w, r) {                      // Epley, capped at 12 reps of usefulness
  if (!w || !r) return 0;
  return Math.round(w * (1 + Math.min(r, 12) / 30) * 10) / 10;
}
function bestE1rm(sets) {
  return sets.reduce((m, s) => Math.max(m, e1rm(s.w, s.r)), 0);
}
function sessionVolume(sess) {             // total kg/lb lifted
  let v = 0;
  (sess.ex || []).forEach(e => (e.sets || []).forEach(s => { v += (s.w || 0) * (s.r || 0); }));
  return Math.round(v);
}
function hardSetsByMuscle(sessions) {      // fractional set counts
  const out = {};
  MUSCLES.forEach(m => out[m] = 0);
  sessions.forEach(sess => (sess.ex || []).forEach(e => {
    const map = EXLIB[e.name] || {};
    const n = (e.sets || []).filter(s => s.r > 0).length;
    Object.keys(map).forEach(m => { if (out[m] !== undefined) out[m] += n * map[m]; });
  }));
  MUSCLES.forEach(m => out[m] = Math.round(out[m] * 10) / 10);
  return out;
}
function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
/* Parse the plain-text plan format the coach writes. Deliberately forgiving:
   DAY: Upper A
   FOCUS: heavy pressing
   NOTE: shoulder was cranky, stop 2 short
   Flat Dumbbell Press | 4x6-8 @2RIR 70lb | pause at the chest
*/
function parseTextPlan(text) {
  const plan = { day: '', focus: '', notes: '', date: today(), ex: [] };
  String(text).split(/\r?\n/).forEach(raw => {
    let line = raw.trim().replace(/^([-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '');
    if (!line) return;
    const kv = /^(day|focus|note|notes)\s*:\s*(.*)$/i.exec(line);
    if (kv) {
      const k = kv[1].toLowerCase();
      if (k === 'day') plan.day = kv[2].trim();
      else if (k === 'focus') plan.focus = kv[2].trim();
      else plan.notes = (plan.notes ? plan.notes + ' ' : '') + kv[2].trim();
      return;
    }
    const parts = line.split('|').map(s => s.trim());
    if (!parts[0]) return;
    const ex = { name: parts[0], target: parts[1] || '', cue: parts[2] || '', sets: [] };
    const r = /(?:rest\s*)(\d+)\s*s?/i.exec(line); if (r) ex.rest = parseInt(r[1], 10);
    plan.ex.push(ex);
  });
  if (!plan.ex.length) throw new Error('no exercises found');
  if (!plan.day) plan.day = 'Session';
  return plan;
}
function parseAnyPlan(v) {
  v = String(v).trim();
  if (v.includes('#t=')) return parseTextPlan(decodeURIComponent(v.split('#t=')[1]));
  if (v.includes('#plan=')) return b64urlDecode(v.split('#plan=')[1].trim());
  if (v.startsWith('{')) return JSON.parse(v);
  if (/^[A-Za-z0-9_-]{40,}$/.test(v)) return b64urlDecode(v);
  return parseTextPlan(v);
}
function seedWeight(target) {
  const m = /(\d+(?:\.\d+)?)\s*(lb|kg)\b/i.exec(target || '');
  return m ? parseFloat(m[1]) : null;
}
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function today() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function daysAgo(dateStr, ref) {
  const a = new Date((ref || today()) + 'T00:00:00'), b = new Date(dateStr + 'T00:00:00');
  return Math.round((a - b) / 86400000);
}

/* Build the compact digest that Claude reads. Keep it small and information-dense. */
function buildDigest(db) {
  const sessions = (db.sessions || []).slice().sort((a, b) => a.date < b.date ? 1 : -1);
  const recent = sessions.slice(0, 10);
  const last28 = sessions.filter(s => daysAgo(s.date) <= 28);

  const lifts = {};
  sessions.forEach(sess => (sess.ex || []).forEach(e => {
    const L = lifts[e.name] || (lifts[e.name] = { last_date: null, best_e1rm: 0, best_date: null, history: [] });
    const b = bestE1rm(e.sets || []);
    if (!L.last_date || sess.date > L.last_date) L.last_date = sess.date;
    if (b > L.best_e1rm) { L.best_e1rm = b; L.best_date = sess.date; }
    if (L.history.length < 4) {
      L.history.push({
        date: sess.date,
        sets: (e.sets || []).map(s => [s.w, s.r, s.rir === null || s.rir === undefined ? '' : s.rir]),
        e1rm: b
      });
    }
  }));

  return {
    schema: 'liftlog/1',
    generated: new Date().toISOString(),
    unit: db.settings.unit,
    profile: db.profile,
    coach_notes: db.coachNotes || '',
    status: {
      today: today(),
      sessions_last_28d: last28.length,
      last_session_date: sessions[0] ? sessions[0].date : null,
      days_since_last: sessions[0] ? daysAgo(sessions[0].date) : null,
      weekly_sets_by_muscle_28d: (() => {
        const t = hardSetsByMuscle(last28), o = {};
        Object.keys(t).forEach(k => o[k] = Math.round(t[k] / 4 * 10) / 10);
        return o;
      })(),
      bodyweight_recent: (db.bodyweight || []).slice(-8)
    },
    lifts,
    recent_sessions: recent.map(s => ({
      date: s.date, day: s.day, notes: s.notes || '', volume: sessionVolume(s),
      ex: (s.ex || []).map(e => ({
        name: e.name, target: e.target || '',
        sets: (e.sets || []).map(x => [x.w, x.r, x.rir === null || x.rir === undefined ? '' : x.rir])
      }))
    })),
    next_plan: db.plan || null
  };
}

/* ---------------- persistence ---------------- */
const KEY = 'liftlog.db.v1';
const DEFAULT_DB = {
  v: 1,
  settings: { owner: '', repo: '', branch: 'main', token: '', unit: 'lb', shas: {} },
  profile: {
    name: 'James',
    height_cm: 179,
    goal: 'Body recomposition: 17.8% -> 13.0% body fat, 135.1 -> 142 lb lean mass',
    baseline_dxa: {
      date: '2026-07-26', body_fat_pct: 17.8, fat_mass_lb: 31.0, lean_mass_lb: 135.1,
      total_mass_lb: 174.2, visceral_fat_lb: 1.01, ag_ratio: 1.62, almi: 9.1, ffmi: 20.3
    },
    target: { body_fat_pct: 13.0, lean_mass_lb: 142, almi: 10.5, ffmi: 21.0, visceral_fat_lb: 0.6 },
    days_per_week: 4, split: 'Upper/Lower', equipment: 'Full commercial gym'
  },
  program: null,
  sessions: [], active: null, plan: null, bodyweight: [], coachNotes: '', dirty: false
};
const clone = o => JSON.parse(JSON.stringify(o));
let db = load();
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_DB);
    return Object.assign(clone(DEFAULT_DB), JSON.parse(raw));
  } catch (e) { return clone(DEFAULT_DB); }
}
function save(markDirty) {
  if (markDirty) db.dirty = true;
  localStorage.setItem(KEY, JSON.stringify(db));
  paintSyncBadge();
}

/* ---------------- GitHub sync ---------------- */
const GH = {
  ok() { const s = db.settings; return !!(s.owner && s.repo && s.token); },
  async put(path, text, message) {
    const s = db.settings;
    const url = `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${path}`;
    const body = { message, content: b64EncodeUtf8(text), branch: s.branch || 'main' };
    if (s.shas[path]) body.sha = s.shas[path];
    let res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 409 || res.status === 422) {           // stale sha -> refetch and retry once
      const head = await fetch(url + '?ref=' + (s.branch || 'main'), { headers: { Authorization: 'Bearer ' + s.token } });
      if (head.ok) {
        const j = await head.json();
        body.sha = j.sha;
        res = await fetch(url, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }
    }
    if (!res.ok) throw new Error(path + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    s.shas[path] = j.content.sha;
    return j;
  },
  async pull(path) {
    const s = db.settings;
    const url = `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${path}?ref=${s.branch || 'main'}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/vnd.github+json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('pull ' + path + ': HTTP ' + res.status);
    const j = await res.json();
    s.shas[path] = j.sha;
    const bin = atob(j.content.replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
};

async function syncNow(silent) {
  if (!GH.ok()) { if (!silent) toast('Add your GitHub details in Settings first'); return false; }
  setSyncState('syncing');
  try {
    const payload = {
      v: 1, updated: new Date().toISOString(),
      profile: db.profile, program: db.program, coachNotes: db.coachNotes,
      bodyweight: db.bodyweight, sessions: db.sessions
    };
    await GH.put('data/log.json', JSON.stringify(payload, null, 1), 'log: ' + db.sessions.length + ' sessions');
    await GH.put('data/index.json', JSON.stringify(buildDigest(db), null, 1), 'digest ' + today());
    db.dirty = false; db.lastSync = new Date().toISOString();
    save(); setSyncState('ok');
    if (!silent) toast('Synced to GitHub');
    return true;
  } catch (e) {
    setSyncState('error'); console.error(e);
    if (!silent) toast('Sync failed: ' + e.message);
    return false;
  }
}
async function restoreFromGitHub() {
  if (!GH.ok()) return toast('Add your GitHub details first');
  try {
    const txt = await GH.pull('data/log.json');
    if (!txt) return toast('No data/log.json in the repo yet');
    const j = JSON.parse(txt);
    db.sessions = j.sessions || []; db.profile = j.profile || db.profile;
    db.program = j.program || db.program; db.coachNotes = j.coachNotes || '';
    db.bodyweight = j.bodyweight || [];
    save(); render(); toast('Restored ' + db.sessions.length + ' sessions');
  } catch (e) { toast('Restore failed: ' + e.message); }
}

/* ---------------- tiny UI framework ---------------- */
const $ = sel => document.querySelector(sel);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };
let route = 'today';
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function setSyncState(s) { $('#syncdot').dataset.state = s; }
function paintSyncBadge() { $('#syncdot').dataset.state = db.dirty ? 'dirty' : 'ok'; }
function unit() { return db.settings.unit; }

/* ---------------- session logic ---------------- */
function lastPerformance(name, excludeId) {
  const s = db.sessions.filter(x => x.id !== excludeId).sort((a, b) => a.date < b.date ? 1 : -1);
  for (const sess of s) {
    const e = (sess.ex || []).find(x => x.name === name);
    if (e && (e.sets || []).length) return { date: sess.date, sets: e.sets, e1rm: bestE1rm(e.sets) };
  }
  return null;
}
function startSession(plan) {
  const p = plan || db.plan || fallbackPlan();
  db.active = {
    id: 's' + Date.now(), date: today(), day: p.day || 'Session', start: new Date().toISOString(),
    notes: '', ex: (p.ex || []).map(e => ({ name: e.name, target: e.target || '', cue: e.cue || '', sets: [] }))
  };
  save(true); route = 'today'; render();
}
function fallbackPlan() {
  const prog = db.program && db.program.days;
  if (!prog || !prog.length) return { day: 'Freestyle', ex: [] };
  const last = db.sessions.slice().sort((a, b) => a.date < b.date ? 1 : -1)[0];
  let i = 0;
  if (last) { const idx = prog.findIndex(d => d.day === last.day); i = idx >= 0 ? (idx + 1) % prog.length : 0; }
  return prog[i];
}
function finishSession() {
  const a = db.active; if (!a) return;
  a.end = new Date().toISOString();
  a.ex = a.ex.filter(e => (e.sets || []).length);
  if (!a.ex.length) { if (!confirm('No sets logged. Discard this session?')) return; db.active = null; save(true); render(); return; }
  db.sessions.push(a); db.active = null;
  if (db.plan && db.plan.day === a.day) db.plan = null;
  save(true); render();
  toast('Session saved. Syncing…');
  syncNow(true).then(ok => toast(ok ? 'Session synced - the coach can see it' : 'Saved locally. Will sync when online.'));
}

/* ---------------- rest timer ---------------- */
let restEnd = 0, restInt = null;
function startRest(sec) {
  restEnd = Date.now() + sec * 1000;
  if (restInt) clearInterval(restInt);
  restInt = setInterval(paintRest, 250); paintRest();
}
function paintRest() {
  const bar = $('#rest'); const left = Math.round((restEnd - Date.now()) / 1000);
  if (left <= 0) { bar.classList.remove('show'); clearInterval(restInt); restInt = null; beep(); return; }
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

/* ---------------- render ---------------- */
function render() {
  const main = $('#main'); main.innerHTML = '';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.route === route));
  ({ today: viewToday, history: viewHistory, stats: viewStats, settings: viewSettings }[route] || viewToday)(main);
  paintSyncBadge();
}

/* --- TODAY --- */
function viewToday(root) {
  if (db.active) return viewActive(root);

  const plan = db.plan;
  const card = el('div', 'card');
  if (plan) {
    card.appendChild(el('div', 'kicker', "Coach's plan" + (plan.date ? ' · ' + plan.date : '')));
    card.appendChild(el('h2', '', plan.day || 'Session'));
    if (plan.focus) card.appendChild(el('p', 'muted', plan.focus));
    const list = el('div', 'exlist');
    (plan.ex || []).forEach(e => {
      const row = el('div', 'exrow');
      const l = el('div', '');
      l.appendChild(el('div', 'exname', e.name));
      l.appendChild(el('div', 'muted small', e.target || ''));
      row.appendChild(l);
      const lp = lastPerformance(e.name);
      if (lp) row.appendChild(el('div', 'muted small right', 'last ' + lp.sets.map(s => s.w + '×' + s.r).join(', ')));
      list.appendChild(row);
    });
    card.appendChild(list);
    if (plan.notes) card.appendChild(el('p', 'note', plan.notes));
    const b = el('button', 'primary big', 'Start session'); b.onclick = () => startSession(plan);
    card.appendChild(b);
  } else {
    card.appendChild(el('div', 'kicker', 'No plan loaded'));
    card.appendChild(el('h2', '', 'Ask the coach'));
    card.appendChild(el('p', 'muted', 'Message Claude for today\'s session, then tap the link it gives you. Or start from the stored program.'));
    const b = el('button', 'primary big', 'Start ' + (fallbackPlan().day || 'session') + ' from program');
    b.onclick = () => startSession(fallbackPlan());
    card.appendChild(b);
  }
  root.appendChild(card);

  // paste-a-plan
  const pc = el('div', 'card');
  pc.appendChild(el('div', 'kicker', 'Load a plan'));
  const ta = el('textarea'); ta.placeholder = "Paste the coach's plan here (text, JSON or link)"; ta.rows = 4;
  pc.appendChild(ta);
  const pb = el('button', '', 'Load plan');
  pb.onclick = () => {
    const v = ta.value.trim(); if (!v) return;
    try { db.plan = parseAnyPlan(v); save(true); render(); toast('Plan loaded'); }
    catch (e) { toast('Could not read that plan'); }
  };
  pc.appendChild(pb);
  root.appendChild(pc);

  // notes for the coach
  const nc = el('div', 'card');
  nc.appendChild(el('div', 'kicker', 'Standing notes for the coach'));
  const nta = el('textarea'); nta.rows = 3; nta.value = db.coachNotes || '';
  nta.placeholder = 'e.g. left shoulder dislikes flat barbell benching; only 45 min on Thursdays';
  nta.onchange = () => { db.coachNotes = nta.value; save(true); };
  nc.appendChild(nta);
  root.appendChild(nc);

  // bodyweight quick entry
  const bc = el('div', 'card row');
  const bi = el('input'); bi.type = 'number'; bi.step = '0.1'; bi.placeholder = 'Bodyweight (' + unit() + ')';
  const bb = el('button', '', 'Log');
  bb.onclick = () => {
    const v = parseFloat(bi.value); if (!v) return;
    db.bodyweight = (db.bodyweight || []).filter(x => x.date !== today());
    db.bodyweight.push({ date: today(), w: v });
    db.bodyweight.sort((a, b) => a.date < b.date ? -1 : 1);
    bi.value = ''; save(true); toast('Bodyweight logged');
  };
  bc.appendChild(bi); bc.appendChild(bb);
  root.appendChild(bc);
}

/* --- ACTIVE SESSION --- */
function viewActive(root) {
  const a = db.active;
  const head = el('div', 'card');
  head.appendChild(el('div', 'kicker', 'In progress · ' + a.date));
  head.appendChild(el('h2', '', a.day));
  const st = el('div', 'muted small', 'Volume ' + sessionVolume(a).toLocaleString() + ' ' + unit());
  head.appendChild(st);
  root.appendChild(head);

  a.ex.forEach((e, ei) => {
    const c = el('div', 'card');
    const top = el('div', 'exhead');
    const l = el('div', '');
    l.appendChild(el('div', 'exname', e.name));
    l.appendChild(el('div', 'muted small', e.target || ''));
    top.appendChild(l);
    const del = el('button', 'ghost tiny', '✕'); del.onclick = () => { if (confirm('Remove ' + e.name + '?')) { a.ex.splice(ei, 1); save(true); render(); } };
    top.appendChild(del);
    c.appendChild(top);

    const lp = lastPerformance(e.name, a.id);
    if (lp) c.appendChild(el('div', 'lastline', 'Last (' + lp.date + '): ' + lp.sets.map(s => s.w + '×' + s.r + (s.rir !== '' && s.rir !== null && s.rir !== undefined ? '@' + s.rir : '')).join('  ') + '  ·  e1RM ' + lp.e1rm));
    if (e.cue) c.appendChild(el('div', 'note', e.cue));

    (e.sets || []).forEach((s, si) => {
      const r = el('div', 'setrow');
      r.appendChild(el('div', 'setno', String(si + 1)));
      r.appendChild(el('div', 'setval', s.w + ' ' + unit() + '  ×  ' + s.r + (s.rir === '' || s.rir === null || s.rir === undefined ? '' : '  @' + s.rir + ' RIR')));
      r.appendChild(el('div', 'muted small', 'e1RM ' + e1rm(s.w, s.r)));
      const x = el('button', 'ghost tiny', '✕'); x.onclick = () => { e.sets.splice(si, 1); save(true); render(); };
      r.appendChild(x);
      c.appendChild(r);
    });

    c.appendChild(setEntry(e, lp));
    root.appendChild(c);
  });

  const add = el('div', 'card');
  add.appendChild(el('div', 'kicker', 'Add exercise'));
  const sel = el('select');
  sel.appendChild(el('option', '', '— pick —'));
  Object.keys(EXLIB).sort().forEach(n => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
  const custom = el('input'); custom.placeholder = 'or type a name';
  const ab = el('button', '', 'Add');
  ab.onclick = () => {
    const n = (custom.value.trim() || sel.value); if (!n || n === '— pick —') return;
    a.ex.push({ name: n, target: '', sets: [] }); custom.value = ''; save(true); render();
  };
  add.appendChild(sel); add.appendChild(custom); add.appendChild(ab);
  root.appendChild(add);

  const nc = el('div', 'card');
  nc.appendChild(el('div', 'kicker', 'Session notes'));
  const ta = el('textarea'); ta.rows = 2; ta.value = a.notes || '';
  ta.placeholder = 'Energy, pain, sleep, anything the coach should know';
  ta.onchange = () => { a.notes = ta.value; save(true); };
  nc.appendChild(ta);
  root.appendChild(nc);

  const fin = el('div', 'card');
  const f = el('button', 'primary big', 'Finish & sync'); f.onclick = finishSession;
  const d = el('button', 'ghost', 'Discard session');
  d.onclick = () => { if (confirm('Discard this session?')) { db.active = null; save(true); render(); } };
  fin.appendChild(f); fin.appendChild(d);
  root.appendChild(fin);
}

/* the fast set-entry widget: steppers, no keyboard needed */
function setEntry(e, lp) {
  const prev = (e.sets || [])[e.sets.length - 1];
  const seed = prev || (lp ? lp.sets[lp.sets.length - 1] : null);
  const step = unit() === 'kg' ? 2.5 : 5;
  let w = seed ? seed.w : 0, r = seed ? seed.r : 8, rir = seed && seed.rir !== '' ? seed.rir : 2;
  if (!prev && e.target) {                                  // seed from "3x8-10 @2RIR 185lb" style targets
    // "4x6-8" -> aim for the top of the range, which is what double progression asks for
    const m = /(\d+)\s*[x×]\s*(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(e.target);
    if (m) r = parseInt(m[3] || m[2], 10);
    const sw = seedWeight(e.target); if (sw) w = sw;
  }

  const box = el('div', 'entry');
  const mk = (label, get, set, inc, fmt) => {
    const g = el('div', 'stepper');
    g.appendChild(el('div', 'slabel', label));
    const row = el('div', 'srow');
    const minus = el('button', 'sbtn', '−');
    const val = el('div', 'sval', fmt(get()));
    const plus = el('button', 'sbtn', '+');
    minus.onclick = () => { set(Math.max(0, get() - inc)); val.textContent = fmt(get()); };
    plus.onclick = () => { set(get() + inc); val.textContent = fmt(get()); };
    val.onclick = () => { const v = prompt(label, get()); if (v !== null && !isNaN(parseFloat(v))) { set(parseFloat(v)); val.textContent = fmt(get()); } };
    row.appendChild(minus); row.appendChild(val); row.appendChild(plus);
    g.appendChild(row);
    return g;
  };
  box.appendChild(mk('Weight', () => w, v => w = v, step, v => v + ''));
  box.appendChild(mk('Reps', () => r, v => r = v, 1, v => v + ''));
  box.appendChild(mk('RIR', () => rir, v => rir = v, 1, v => v + ''));
  const log = el('button', 'primary logbtn', 'Log set');
  log.onclick = () => {
    if (!r) return;
    e.sets.push({ w: w, r: r, rir: rir });
    save(true); startRest(e.rest || 150); render();
  };
  box.appendChild(log);
  return box;
}

/* --- HISTORY --- */
function viewHistory(root) {
  const s = db.sessions.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  if (!s.length) { root.appendChild(el('div', 'card', 'No sessions yet.')); return; }
  s.forEach(sess => {
    const c = el('div', 'card');
    c.appendChild(el('div', 'kicker', sess.date + ' · ' + (sess.day || '')));
    (sess.ex || []).forEach(e => {
      const r = el('div', 'exrow');
      r.appendChild(el('div', 'exname small', e.name));
      r.appendChild(el('div', 'muted small right', (e.sets || []).map(x => x.w + '×' + x.r).join(', ')));
      c.appendChild(r);
    });
    c.appendChild(el('div', 'muted small', 'Volume ' + sessionVolume(sess).toLocaleString() + ' ' + unit()));
    if (sess.notes) c.appendChild(el('div', 'note', sess.notes));
    root.appendChild(c);
  });
}

/* --- STATS --- */
function viewStats(root) {
  const last28 = db.sessions.filter(s => daysAgo(s.date) <= 28);
  const wk = hardSetsByMuscle(last28);
  const c = el('div', 'card');
  c.appendChild(el('div', 'kicker', 'Weekly hard sets (28-day average)'));
  MUSCLES.forEach(m => {
    const v = Math.round(wk[m] / 4 * 10) / 10;
    const row = el('div', 'bar');
    row.appendChild(el('div', 'blabel', MUSCLE_LABEL[m]));
    const track = el('div', 'btrack');
    const fill = el('div', 'bfill'); fill.style.width = Math.min(100, v / 20 * 100) + '%';
    if (v < 8) fill.classList.add('low'); else if (v > 22) fill.classList.add('high');
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'bval', String(v)));
    c.appendChild(row);
  });
  c.appendChild(el('div', 'muted small', 'Target band for growth: roughly 10-20 hard sets per muscle per week.'));
  root.appendChild(c);

  const lifts = {};
  db.sessions.forEach(s => (s.ex || []).forEach(e => {
    const b = bestE1rm(e.sets || []);
    if (!lifts[e.name] || b > lifts[e.name].v) lifts[e.name] = { v: b, d: s.date };
  }));
  const pc = el('div', 'card');
  pc.appendChild(el('div', 'kicker', 'Estimated 1RM bests'));
  Object.keys(lifts).sort((a, b) => lifts[b].v - lifts[a].v).forEach(n => {
    const r = el('div', 'exrow');
    r.appendChild(el('div', 'exname small', n));
    r.appendChild(el('div', 'muted small right', lifts[n].v + ' ' + unit() + ' · ' + lifts[n].d));
    pc.appendChild(r);
  });
  root.appendChild(pc);

  const bw = db.bodyweight || [];
  if (bw.length) {
    const b = el('div', 'card');
    b.appendChild(el('div', 'kicker', 'Bodyweight'));
    const last = bw.slice(-7);
    const avg = Math.round(last.reduce((s, x) => s + x.w, 0) / last.length * 10) / 10;
    b.appendChild(el('div', 'big-num', avg + ' ' + unit()));
    b.appendChild(el('div', 'muted small', '7-day average · latest ' + bw[bw.length - 1].w + ' on ' + bw[bw.length - 1].date));
    root.appendChild(b);
  }

  const g = el('div', 'card');
  g.appendChild(el('div', 'kicker', 'Goal'));
  g.appendChild(el('div', '', db.profile.goal));
  g.appendChild(el('div', 'muted small', 'DXA baseline ' + db.profile.baseline_dxa.date + ' · retest around ' + '2026-10-24'));
  root.appendChild(g);
}

/* --- SETTINGS --- */
function viewSettings(root) {
  const s = db.settings;
  const c = el('div', 'card');
  c.appendChild(el('div', 'kicker', 'GitHub sync'));
  const f = (label, key, type, ph) => {
    const w = el('div', 'field');
    w.appendChild(el('label', '', label));
    const i = el('input'); i.type = type || 'text'; i.value = s[key] || ''; i.placeholder = ph || '';
    i.onchange = () => { s[key] = i.value.trim(); save(); };
    w.appendChild(i); return w;
  };
  c.appendChild(f('Owner (your GitHub username)', 'owner', 'text', 'jamesmcauley'));
  c.appendChild(f('Repo', 'repo', 'text', 'liftlog'));
  c.appendChild(f('Branch', 'branch', 'text', 'main'));
  c.appendChild(f('Fine-grained token', 'token', 'password', 'github_pat_…'));
  const u = el('div', 'field');
  u.appendChild(el('label', '', 'Units'));
  const us = el('select');
  ['lb', 'kg'].forEach(x => { const o = el('option', '', x); o.value = x; if (s.unit === x) o.selected = true; us.appendChild(o); });
  us.onchange = () => { s.unit = us.value; save(true); render(); };
  u.appendChild(us); c.appendChild(u);

  const b1 = el('button', 'primary', 'Sync now'); b1.onclick = () => syncNow();
  const b2 = el('button', '', 'Restore from GitHub'); b2.onclick = restoreFromGitHub;
  c.appendChild(b1); c.appendChild(b2);
  c.appendChild(el('div', 'muted small', db.lastSync ? 'Last sync ' + new Date(db.lastSync).toLocaleString() : 'Never synced'));
  root.appendChild(c);

  const d = el('div', 'card');
  d.appendChild(el('div', 'kicker', 'Data'));
  const ex = el('button', '', 'Copy digest (what the coach sees)');
  ex.onclick = () => { navigator.clipboard.writeText(JSON.stringify(buildDigest(db))); toast('Digest copied'); };
  const dl = el('button', '', 'Download full backup');
  dl.onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'liftlog-backup-' + today() + '.json'; a.click();
  };
  const rs = el('button', 'ghost', 'Reset local data');
  rs.onclick = () => { if (confirm('Erase local data? Synced data in GitHub is kept.')) { localStorage.removeItem(KEY); db = load(); render(); } };
  d.appendChild(ex); d.appendChild(dl); d.appendChild(rs);
  root.appendChild(d);

  const p = el('div', 'card');
  p.appendChild(el('div', 'kicker', 'Program (JSON)'));
  const ta = el('textarea'); ta.rows = 6; ta.value = db.program ? JSON.stringify(db.program) : '';
  ta.onchange = () => { try { db.program = JSON.parse(ta.value); save(true); toast('Program saved'); } catch (e) { toast('Invalid JSON'); } };
  p.appendChild(ta);
  root.appendChild(p);
}

/* ---------------- boot ---------------- */
function handleHash() {
  const h = location.hash || '';
  if (h.startsWith('#plan=') || h.startsWith('#t=')) {
    try {
      db.plan = parseAnyPlan(location.href);
      history.replaceState(null, '', location.pathname);
      save(true); route = 'today'; toast('Plan loaded from coach');
    } catch (e) { toast('Bad plan link'); }
  }
}
window.addEventListener('hashchange', () => { handleHash(); render(); });
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { route = t.dataset.route; render(); });
  $('#restStop').onclick = () => { restEnd = 0; paintRest(); };
  $('#restPlus').onclick = () => { restEnd += 30000; paintRest(); };
  $('#syncdot').onclick = () => syncNow();
  if (!db.program) {
    fetch('data/program.json').then(r => r.ok ? r.json() : null).then(j => { if (j) { db.program = j; save(); render(); } }).catch(() => {});
  }
  handleHash(); render();
  window.addEventListener('online', () => { if (db.dirty) syncNow(true); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});

/* export for headless tests */
if (typeof module !== 'undefined') module.exports = {
  e1rm, bestE1rm, sessionVolume, hardSetsByMuscle, buildDigest, daysAgo,
  parseTextPlan, parseAnyPlan, seedWeight, b64urlEncode, b64urlDecode, b64EncodeUtf8, EXLIB, DEFAULT_DB
};
