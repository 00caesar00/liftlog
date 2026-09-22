/* LiftLog core: pure data logic, no DOM. Shared by the app (browser) and the tests (node).
   Everything here takes the db as an argument so it can be tested headlessly.

   Data rules that keep old data safe:
   - Raw logs are never rewritten. Names, warm-ups and loads are interpreted at read time.
   - migrate() only ADDS fields. Every version step is a small pure function.            */
(function () {
'use strict';

/* ---------------- exercise catalog ----------------
   name: [muscles, kind, load, pattern, extra]
   kind:  lc = lower compound, uc = upper compound, iso = isolation, core
   load:  barbell | dumbbell (per hand) | cable | machine | smith | plate | bw (bodyweight + added)
          | assisted (bodyweight minus assistance)                                              */
const CATALOG = {
  // push
  'Barbell Bench Press':        [{chest:1, tri:0.5, delt:0.5}, 'uc', 'barbell',  'horizontal push'],
  'Incline Barbell Bench':      [{chest:1, tri:0.5, delt:0.5}, 'uc', 'barbell',  'incline push'],
  'Incline Dumbbell Press':     [{chest:1, tri:0.5, delt:0.5}, 'uc', 'dumbbell', 'incline push'],
  'Flat Dumbbell Press':        [{chest:1, tri:0.5, delt:0.5}, 'uc', 'dumbbell', 'horizontal push'],
  'Machine Chest Press':        [{chest:1, tri:0.5, delt:0.5}, 'uc', 'machine',  'horizontal push'],
  'Cable Fly':                  [{chest:1}, 'iso', 'cable',   'chest fly'],
  'Pec Deck':                   [{chest:1}, 'iso', 'machine', 'chest fly'],
  'Overhead Press':             [{delt:1, tri:0.5}, 'uc', 'barbell',  'vertical push'],
  'Seated Dumbbell Press':      [{delt:1, tri:0.5}, 'uc', 'dumbbell', 'vertical push'],
  'Machine Shoulder Press':     [{delt:1, tri:0.5}, 'uc', 'machine',  'vertical push'],
  'Lateral Raise':              [{delt:1}, 'iso', 'dumbbell', 'lateral raise'],
  'Cable Lateral Raise':        [{delt:1}, 'iso', 'cable',    'lateral raise'],
  'Rear Delt Fly':              [{delt:1, back:0.5}, 'iso', 'machine', 'rear delt'],
  'Triceps Pushdown':           [{tri:1}, 'iso', 'cable',   'triceps'],
  'Overhead Cable Extension':   [{tri:1}, 'iso', 'cable',   'triceps'],
  'Skullcrusher':               [{tri:1}, 'iso', 'barbell', 'triceps'],
  'Dip':                        [{chest:1, tri:1}, 'uc', 'bw', 'vertical push'],
  // pull
  'Pull-Up':                    [{back:1, bi:0.5}, 'uc', 'bw',       'vertical pull'],
  'Assisted Pull-Up':           [{back:1, bi:0.5}, 'uc', 'assisted', 'vertical pull'],
  'Chin-Up':                    [{back:1, bi:0.5}, 'uc', 'bw',       'vertical pull'],
  'Lat Pulldown':               [{back:1, bi:0.5}, 'uc', 'cable',    'vertical pull'],
  'Chest-Supported Row':        [{back:1, bi:0.5}, 'uc', 'machine',  'horizontal pull'],
  'Barbell Row':                [{back:1, bi:0.5}, 'uc', 'barbell',  'horizontal pull'],
  'Seated Cable Row':           [{back:1, bi:0.5}, 'uc', 'cable',    'horizontal pull'],
  'Single-Arm Dumbbell Row':    [{back:1, bi:0.5}, 'uc', 'dumbbell', 'horizontal pull'],
  'Face Pull':                  [{delt:1, back:0.5}, 'iso', 'cable', 'rear delt'],
  'Barbell Curl':               [{bi:1}, 'iso', 'barbell',  'biceps'],
  'Incline Dumbbell Curl':      [{bi:1}, 'iso', 'dumbbell', 'biceps'],
  'Hammer Curl':                [{bi:1}, 'iso', 'dumbbell', 'biceps'],
  'Cable Curl':                 [{bi:1}, 'iso', 'cable',    'biceps'],
  'Shrug':                      [{back:1}, 'iso', 'dumbbell', 'shrug'],
  // legs
  'Back Squat':                 [{quad:1, glute:0.5}, 'lc', 'barbell', 'squat'],
  'Front Squat':                [{quad:1, glute:0.5}, 'lc', 'barbell', 'squat'],
  'Smith Machine Squat':        [{quad:1, glute:0.5}, 'lc', 'smith',   'squat'],
  'Hack Squat':                 [{quad:1, glute:0.5}, 'lc', 'plate',   'squat'],
  'Leg Press':                  [{quad:1, glute:0.5}, 'lc', 'plate',   'squat'],
  'Bulgarian Split Squat':      [{quad:1, glute:1}, 'lc', 'dumbbell', 'single-leg', {perSide:true}],
  'Walking Lunge':              [{quad:1, glute:1}, 'lc', 'dumbbell', 'single-leg'],
  'Leg Extension':              [{quad:1}, 'iso', 'machine', 'knee extension'],
  'Romanian Deadlift':          [{ham:1, glute:1}, 'lc', 'barbell',  'hinge'],
  'Dumbbell Romanian Deadlift': [{ham:1, glute:1}, 'lc', 'dumbbell', 'hinge'],
  'Conventional Deadlift':      [{ham:1, glute:1, back:0.5}, 'lc', 'barbell', 'hinge'],
  'Trap Bar Deadlift':          [{ham:1, glute:1, quad:0.5}, 'lc', 'barbell', 'hinge'],
  'Seated Leg Curl':            [{ham:1}, 'iso', 'machine', 'knee flexion'],
  'Lying Leg Curl':             [{ham:1}, 'iso', 'machine', 'knee flexion'],
  'Hip Thrust':                 [{glute:1, ham:0.5}, 'lc', 'barbell', 'hip thrust'],
  'Hip Abduction':              [{glute:1}, 'iso', 'machine', 'hip abduction'],
  'Hip Adduction':              [{quad:0.5}, 'iso', 'machine', 'hip adduction'],
  'Back Extension':             [{ham:1, glute:1}, 'iso', 'plate', 'hinge'],
  'Standing Calf Raise':        [{calf:1}, 'iso', 'machine', 'calf'],
  'Seated Calf Raise':          [{calf:1}, 'iso', 'machine', 'calf'],
  // core
  'Hanging Leg Raise':          [{abs:1}, 'core', 'bw',      'core'],
  'Cable Crunch':               [{abs:1}, 'core', 'cable',   'core'],
  'Machine Crunch':             [{abs:1}, 'core', 'machine', 'core'],
  'Ab Wheel':                   [{abs:1}, 'core', 'bw',      'core'],
  'Plank':                      [{abs:1}, 'core', 'bw',      'core'],
};
/* Spelling variants that are the same movement. The user can add more in the app. */
const BUILTIN_ALIASES = {
  'Overhead Cable Tricep Extension': 'Overhead Cable Extension',
  'Overhead Cable Triceps Extension': 'Overhead Cable Extension',
  'Tricep Pushdown': 'Triceps Pushdown',
  'RDL': 'Romanian Deadlift',
  'DB Romanian Deadlift': 'Dumbbell Romanian Deadlift',
  'Pullup': 'Pull-Up', 'Pull Up': 'Pull-Up', 'Chinup': 'Chin-Up', 'Chin Up': 'Chin-Up',
};
const MUSCLES = ['chest','back','delt','bi','tri','quad','ham','glute','calf','abs'];
const MUSCLE_LABEL = {chest:'Chest',back:'Back',delt:'Delts',bi:'Biceps',tri:'Triceps',quad:'Quads',ham:'Hams',glute:'Glutes',calf:'Calves',abs:'Abs'};
const KIND_LABEL = { lc: 'Lower compounds', uc: 'Upper compounds', iso: 'Isolation', core: 'Core', '?': 'Not in library' };
const LOAD_NOTE = {
  barbell: 'total incl. bar', dumbbell: 'per dumbbell', cable: 'stack weight', machine: 'as shown on machine',
  smith: 'plates only', plate: 'plates loaded', bw: 'added to bodyweight', assisted: 'assistance'
};
const DEFAULT_REST = { lc: 180, uc: 150, iso: 75, core: 60, '?': 120 };

/* ---------------- small helpers ---------------- */
const clone = o => JSON.parse(JSON.stringify(o));
const round1 = x => Math.round(x * 10) / 10;
function today(d) {
  d = d || new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function daysAgo(dateStr, ref) {
  const a = new Date((ref || today()) + 'T00:00:00'), b = new Date(dateStr + 'T00:00:00');
  return Math.round((a - b) / 86400000);
}
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return today(d); }
const byDateAsc = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : ((a.start || '') < (b.start || '') ? -1 : 1);
const byDateDesc = (a, b) => -byDateAsc(a, b);
const hasRir = s => s.rir !== '' && s.rir !== null && s.rir !== undefined;

function e1rm(w, r) {                      // Epley, capped at 12 reps of usefulness
  if (!w || !r || w <= 0) return 0;
  return round1(w * (1 + Math.min(r, 12) / 30));
}

/* "4x6-8 @2RIR 75lb rest 120" -> {sets:4, lo:6, hi:8, rir:2, load:75, unit:'lb', rest:120} */
function parseTarget(t) {
  t = String(t || '');
  const out = { sets: null, lo: null, hi: null, rir: null, load: null, unit: null, rest: null };
  const m = /(\d+)\s*[x×]\s*(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(t);
  if (m) { out.sets = +m[1]; out.lo = +m[2]; out.hi = +(m[3] || m[2]); }
  const r = /@\s*(\d+(?:\.\d+)?)\s*RIR/i.exec(t); if (r) out.rir = +r[1];
  const l = /(-?\d+(?:\.\d+)?)\s*(lb|lbs|kg)\b/i.exec(t); if (l) { out.load = +l[1]; out.unit = l[2].toLowerCase().replace('lbs', 'lb'); }
  const rs = /\brest\s*(\d+)(?::(\d{2}))?\s*(s|sec|secs|m|min|mins)?\b/i.exec(t);
  if (rs) out.rest = rs[2] ? (+rs[1]) * 60 + (+rs[2]) : /^m/i.test(rs[3] || '') ? (+rs[1]) * 60 : +rs[1];
  return out;
}
function seedWeight(target) { const p = parseTarget(target); return p.load; }

/* ---------------- catalog resolution ---------------- */
function canon(name, db) {
  let n = String(name || '').trim(), hops = 0;
  const user = (db && db.aliases) || {};
  while (hops++ < 6) {
    if (Object.prototype.hasOwnProperty.call(user, n)) { if (user[n] === n) return n; n = user[n]; continue; }
    if (BUILTIN_ALIASES[n]) { n = BUILTIN_ALIASES[n]; continue; }
    break;
  }
  return n;
}
function exInfo(name, db) {
  const n = canon(name, db);
  const c = CATALOG[n];
  const u = (db && db.exercises && db.exercises[n]) || {};
  const base = c ? { m: c[0], kind: c[1], load: c[2], pattern: c[3], perSide: !!(c[4] && c[4].perSide) }
                 : { m: {}, kind: '?', load: 'machine', pattern: 'other', perSide: false };
  const info = Object.assign({ name: n, known: !!c || !!u.m }, base, u);
  const kg = db && db.settings && db.settings.unit === 'kg';
  if (!info.step) info.step = ['barbell', 'smith', 'plate', 'machine', 'bw', 'assisted'].includes(info.load) ? (kg ? 2.5 : 5) : (kg ? 1.25 : 2.5);
  if (!info.rest) info.rest = DEFAULT_REST[info.kind] || 120;
  return info;
}

/* ---------------- set semantics ---------------- */
/* Explicit flag wins (t:'w' warm-up, t:'n' working). Legacy sets without a flag are guessed:
   a leading set, before the first near-top set, that is well under the top weight or very easy. */
function warmupFlags(sets, info) {
  sets = sets || [];
  const top = sets.reduce((m, s) => Math.max(m, s.w || 0), 0);
  const firstTop = sets.findIndex(s => (s.w || 0) >= top * 0.9);
  const guessOk = top > 0 && sets.length >= 2 && !(info && (info.load === 'bw' || info.load === 'assisted'));
  return sets.map((s, i) => {
    if (s.t === 'w') return true;
    if (s.t === 'n') return false;
    if (!guessOk || i >= firstTop) return false;
    return (s.w || 0) < top * 0.75 || (hasRir(s) && s.rir >= 4);
  });
}
function bodyweightOn(db, date) {
  const bw = (db.bodyweight || []).slice().sort(byDateAsc);
  let v = null;
  for (const x of bw) { if (x.date <= date) v = x.w; }
  if (v === null && bw.length) v = bw[0].w;
  if (v !== null) return v;
  const scans = (db.scans || []).slice().sort(byDateAsc);
  const s = scans.filter(x => x.date <= date).pop() || scans[0];
  const lb = (s && s.total_mass_lb) || (db.profile && db.profile.baseline_dxa && db.profile.baseline_dxa.total_mass_lb) || 0;
  return db.settings && db.settings.unit === 'kg' ? round1(lb / 2.20462) : lb;
}
function effLoad(db, info, w, date) {
  if (info.load === 'bw') return bodyweightOn(db, date) + (w || 0);
  if (info.load === 'assisted') return bodyweightOn(db, date) - Math.abs(w || 0);
  return w || 0;
}
/* One exercise entry of one session, fully interpreted. */
function readEntry(db, sess, e) {
  const info = exInfo(e.name, db);
  const flags = warmupFlags(e.sets, info);
  const sets = (e.sets || []).map((s, i) => ({ w: s.w, r: s.r, rir: hasRir(s) ? s.rir : '', warm: flags[i], eff: effLoad(db, info, s.w, sess.date), e1: 0 }));
  sets.forEach(s => { s.e1 = s.warm ? 0 : e1rm(s.eff, s.r); });
  const work = sets.filter(s => !s.warm && s.r > 0);
  let top = null; work.forEach(s => { if (!top || s.e1 > top.e1) top = s; });
  return { info, name: info.name, raw: e.name, target: e.target || '', sets, work, top, best: top ? top.e1 : 0 };
}
function bestE1rm(sets) { return (sets || []).reduce((m, s) => Math.max(m, e1rm(s.w, s.r)), 0); }
function sessionVolume(sess, db) {
  db = db || {};
  let v = 0;
  (sess.ex || []).forEach(e => readEntry(db, sess, e).work.forEach(s => { v += (s.eff || 0) * (s.r || 0); }));
  return Math.round(v);
}
function hardSetsByMuscle(sessions, db) {
  db = db || {};
  const out = {}; MUSCLES.forEach(m => out[m] = 0);
  sessions.forEach(sess => (sess.ex || []).forEach(e => {
    const E = readEntry(db, sess, e);
    const n = E.work.length / (E.info.perSide ? 2 : 1);
    Object.keys(E.info.m).forEach(m => { if (out[m] !== undefined) out[m] += n * E.info.m[m]; });
  }));
  MUSCLES.forEach(m => out[m] = round1(out[m]));
  return out;
}

/* ---------------- per-lift history ---------------- */
/* canonical name -> [{date, sid, best, top, work, warm, target, raw, sets}] oldest first */
function liftSeries(db) {
  const out = {};
  (db.sessions || []).slice().sort(byDateAsc).forEach(sess => (sess.ex || []).forEach(e => {
    const E = readEntry(db, sess, e);
    if (!E.work.length) return;
    (out[E.name] || (out[E.name] = [])).push({
      date: sess.date, sid: sess.id, best: E.best, top: E.top, work: E.work.length,
      warm: E.sets.length - E.work.length, target: E.target, raw: E.raw, sets: E.sets
    });
  }));
  return out;
}
function liftSummary(S, ref) {
  ref = ref || today();
  if (!S || !S.length) return null;
  let best = 0, bestIdx = 0; const prIdx = [];
  S.forEach((p, i) => { if (p.best > best) { best = p.best; bestIdx = i; prIdx.push(i); } });
  const recent = S.filter(p => daysAgo(p.date, ref) <= 56);
  let trend = null;
  if (recent.length >= 3 && daysAgo(recent[0].date, recent[recent.length - 1].date) >= 14) {
    const xs = recent.map(p => -daysAgo(p.date, ref)), ys = recent.map(p => p.best);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) * (x - mx); });
    trend = den ? round1((num / den) * 28 / my * 100) : null;
  }
  const last = S[S.length - 1];
  const t = parseTarget(last.target);
  let hitTop = null;
  if (t.hi) hitTop = last.work >= (t.sets || 1) && last.sets.filter(s => !s.warm && s.r > 0).every(s => s.r >= t.hi);
  // rep PRs: most reps ever done at each weight (working sets)
  const atW = {};
  S.forEach(p => p.sets.forEach(s => { if (!s.warm && s.r > 0 && (!atW[s.w] || s.r > atW[s.w].r)) atW[s.w] = { w: s.w, r: s.r, date: p.date }; }));
  return {
    sessions: S.length, first: S[0], last, best, bestDate: S[bestIdx].date, prIdx,
    sinceBest: S.length - 1 - bestIdx, stalled: S.length - 1 - bestIdx >= 3,
    change: round1(last.best - S[0].best), changePct: S[0].best ? round1((last.best - S[0].best) / S[0].best * 100) : null,
    trend, hitTop, repPRs: Object.values(atW).sort((a, b) => b.w - a.w)
  };
}

/* ---------------- plan parsing ---------------- */
/* DAY: Upper A
   FOCUS: heavy pressing
   NOTE: shoulder was cranky, stop 2 short
   Flat Dumbbell Press | 4x6-8 @2RIR 70lb rest 180 | pause at the chest          */
function parseTextPlan(text) {
  const plan = { day: '', focus: '', notes: '', date: today(), ex: [] };
  String(text).split(/\r?\n/).forEach(raw => {
    let line = raw.trim().replace(/^([-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').replace(/^`+|`+$/g, '');
    if (!line || /^```/.test(line)) return;
    const kv = /^(day|focus|note|notes)\s*:\s*(.*)$/i.exec(line);
    if (kv) {
      const k = kv[1].toLowerCase();
      if (k === 'day') plan.day = kv[2].trim();
      else if (k === 'focus') plan.focus = kv[2].trim();
      else plan.notes = (plan.notes ? plan.notes + ' ' : '') + kv[2].trim();
      return;
    }
    if (!line.includes('|') && plan.ex.length === 0 && !plan.day) return;   // stray prose before the block
    const parts = line.split('|').map(s => s.trim());
    if (!parts[0]) return;
    const ex = { name: parts[0], target: parts[1] || '', cue: parts[2] || '', sets: [] };
    const t = parseTarget(ex.target); if (t.rest) ex.rest = t.rest;
    plan.ex.push(ex);
  });
  if (!plan.ex.length) throw new Error('no exercises found');
  if (!plan.day) plan.day = 'Session';
  return plan;
}
/* Pull the plan block out of a full coach reply (brief + fenced block). */
function extractPlanBlock(text) {
  text = String(text || '');
  const fences = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/gi)].map(m => m[1]).filter(b => /^\s*DAY\s*:/im.test(b));
  if (fences.length) return { block: fences[fences.length - 1], brief: text.replace(/```[a-z]*\n[\s\S]*?```/gi, '').trim() };
  const i = text.search(/^\s*DAY\s*:/im);
  if (i >= 0) return { block: text.slice(i), brief: text.slice(0, i).trim() };
  return { block: text, brief: '' };
}
function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function parseAnyPlan(v) {
  v = String(v).trim();
  if (v.includes('#t=')) return parseTextPlan(decodeURIComponent(v.split('#t=')[1]));
  if (v.includes('#plan=')) return b64urlDecode(v.split('#plan=')[1].trim());
  if (v.startsWith('{')) return JSON.parse(v);
  if (/^[A-Za-z0-9_-]{40,}$/.test(v)) return b64urlDecode(v);
  const x = extractPlanBlock(v);
  const p = parseTextPlan(x.block);
  if (x.brief) p.brief = x.brief;
  return p;
}

/* ---------------- schema + migration ---------------- */
const SCHEMA = 2;
const DEFAULT_DB = {
  v: SCHEMA,
  settings: { owner: '', repo: '', branch: 'main', token: '', unit: 'lb', apiKey: '', model: 'claude-sonnet-5' },
  profile: {
    name: 'James', height_cm: 179,
    goal: 'Body recomposition: 17.8% -> 13.0% body fat, 135.1 -> 142 lb lean mass',
    baseline_dxa: { date: '2026-07-26', body_fat_pct: 17.8, fat_mass_lb: 31.0, lean_mass_lb: 135.1,
      total_mass_lb: 174.2, visceral_fat_lb: 1.01, ag_ratio: 1.62, almi: 9.1, ffmi: 20.3 },
    target: { body_fat_pct: 13.0, lean_mass_lb: 142, almi: 10.5, ffmi: 21.0, visceral_fat_lb: 0.6 },
    days_per_week: 4, split: 'Upper/Lower', equipment: 'Full commercial gym'
  },
  program: null, sessions: [], active: null, plan: null, bodyweight: [], scans: [],
  aliases: {}, exercises: {}, coachNotes: '', dirty: false
};
/* Each step takes a version-N object and returns version N+1. Only adds, never deletes. */
const MIGRATIONS = {
  1: d => {
    d.scans = d.scans || [];
    const b = d.profile && d.profile.baseline_dxa;
    if (b && !d.scans.some(s => s.date === b.date)) d.scans.push(Object.assign({ source: 'DXA' }, b));
    d.aliases = d.aliases || {};
    d.exercises = d.exercises || {};
    if (d.settings) { d.settings.apiKey = d.settings.apiKey || ''; d.settings.model = d.settings.model || 'claude-sonnet-5'; }
    d.migrated = Object.assign({}, d.migrated, { from1: new Date().toISOString() });
    d.v = 2; return d;
  }
};
function migrate(raw) {
  const d = clone(raw || {});
  let v = d.v || 1;
  while (v < SCHEMA) { if (!MIGRATIONS[v]) throw new Error('no migration from v' + v); MIGRATIONS[v](d); v = d.v; }
  // fill anything missing with defaults, without touching what exists
  const base = clone(DEFAULT_DB);
  Object.keys(base).forEach(k => { if (d[k] === undefined) d[k] = base[k]; });
  d.settings = Object.assign(base.settings, d.settings || {});
  return d;
}

/* ---------------- repo file layout ----------------
   data/meta.json            everything except sessions
   data/sessions/YYYY.json   sessions for one calendar year
   data/index.json           digest the coach reads                                   */
function repoFiles(db) {
  const years = {};
  (db.sessions || []).forEach(s => { const y = (s.date || '0000').slice(0, 4); (years[y] = years[y] || []).push(s); });
  const files = {};
  Object.keys(years).sort().forEach(y => {
    files['data/sessions/' + y + '.json'] = JSON.stringify({ v: SCHEMA, year: +y, sessions: years[y].sort(byDateAsc) }, null, 1);
  });
  files['data/meta.json'] = JSON.stringify({
    v: SCHEMA, updated: new Date().toISOString(), years: Object.keys(years).sort(),
    profile: db.profile, program: db.program, coachNotes: db.coachNotes, bodyweight: db.bodyweight,
    scans: db.scans, aliases: db.aliases, exercises: db.exercises, plan: db.plan, active: db.active
  }, null, 1);
  return files;
}
function fromRepoFiles(meta, yearFiles) {
  const d = Object.assign({}, meta);
  d.sessions = [];
  (yearFiles || []).forEach(f => { d.sessions = d.sessions.concat(f.sessions || []); });
  delete d.years; delete d.updated;
  return d;
}

/* ---------------- digest for the coach ---------------- */
function buildDigest(db, ref) {
  ref = ref || today();
  const sessions = (db.sessions || []).slice().sort(byDateDesc);
  const last28 = sessions.filter(s => daysAgo(s.date, ref) <= 28 && daysAgo(s.date, ref) >= 0);
  const series = liftSeries(db);
  const compactSets = (E) => E.sets.map(s => { const a = [s.w, s.r, s.rir]; if (s.warm) a.push('w'); return a; });

  const lifts = {};
  Object.keys(series).forEach(n => {
    const S = series[n], sum = liftSummary(S, ref), info = exInfo(n, db);
    const cutoff = addDays(ref, -182);
    const recentPts = S.filter(p => p.date >= cutoff), older = S.filter(p => p.date < cutoff);
    const monthly = {};
    older.forEach(p => { const m = p.date.slice(0, 7); monthly[m] = Math.max(monthly[m] || 0, p.best); });
    const rawNames = [...new Set(S.map(p => p.raw).filter(r => r !== n))];
    lifts[n] = {
      kind: info.kind, pattern: info.pattern, load: info.load + ' (' + (LOAD_NOTE[info.load] || '') + ')',
      muscles: Object.keys(info.m),
      sessions: sum.sessions, first_date: S[0].date, last_date: sum.last.date,
      best_e1rm: sum.best, best_date: sum.bestDate, sessions_since_pr: sum.sinceBest, stalled: sum.stalled,
      e1rm_change_since_first: sum.change, trend_pct_per_4wk: sum.trend,
      last: {
        date: sum.last.date, target: sum.last.target, hit_top_of_range: sum.hitTop,
        sets: compactSets(sum.last)
      },
      series: recentPts.map(p => [p.date, p.best, p.top.w + 'x' + p.top.r]),
    };
    if (Object.keys(monthly).length) lifts[n].monthly_best_older = Object.keys(monthly).sort().map(m => [m, monthly[m]]);
    if (rawNames.length) lifts[n].logged_as = rawNames;
    if (info.perSide) lifts[n].logged_per_side = true;
  });

  const wk = hardSetsByMuscle(last28, db), weekly = {};
  Object.keys(wk).forEach(k => weekly[k] = round1(wk[k] / 4));
  const bw = (db.bodyweight || []).slice().sort(byDateAsc);
  const bw7 = bw.filter(x => daysAgo(x.date, ref) <= 7);
  const a = db.active;

  return {
    schema: 'liftlog/2',
    generated: new Date().toISOString(),
    unit: (db.settings && db.settings.unit) || 'lb',
    legend: 'sets are [weight, reps, RIR]; a 4th element "w" marks a warm-up, excluded from e1RM, volume and set counts. ' +
            'e1RM = Epley on working sets, reps capped at 12; for bodyweight/assisted lifts it uses bodyweight plus added load (or minus assistance). ' +
            'series = [date, best e1RM that session, top set] for the last 26 weeks; monthly_best_older covers earlier months. ' +
            'Lifts are keyed by canonical name; logged_as lists other names the same lift was logged under.',
    profile: db.profile,
    scans: db.scans || [],
    coach_notes: db.coachNotes || '',
    status: {
      today: ref,
      sessions_last_28d: last28.length,
      last_session_date: sessions[0] ? sessions[0].date : null,
      days_since_last: sessions[0] ? daysAgo(sessions[0].date, ref) : null,
      weekly_sets_by_muscle_28d: weekly,
      bodyweight_recent: bw.slice(-8),
      bodyweight_7d_avg: bw7.length ? round1(bw7.reduce((s, x) => s + x.w, 0) / bw7.length) : null
    },
    in_progress: a ? { date: a.date, day: a.day, started: a.start,
      ex: (a.ex || []).map(e => ({ name: canon(e.name, db), target: e.target || '', sets: compactSets(readEntry(db, a, e)) })) } : null,
    lifts,
    recent_sessions: sessions.slice(0, 4).map(s => ({
      date: s.date, day: s.day, notes: s.notes || '', volume: sessionVolume(s, db),
      ex: (s.ex || []).map(e => { const E = readEntry(db, s, e); return { name: E.name, target: E.target, sets: compactSets(E) }; })
    })),
    next_plan: db.plan ? { day: db.plan.day, focus: db.plan.focus || '', date: db.plan.date, ex: (db.plan.ex || []).map(e => e.name + ' | ' + (e.target || '')) } : null
  };
}

/* ---------------- git blob hash (to skip unchanged files) ---------------- */
async function gitBlobSha(text) {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode('blob ' + body.length + '\0');
  const buf = new Uint8Array(head.length + body.length); buf.set(head); buf.set(body, head.length);
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

const LiftCore = {
  CATALOG, BUILTIN_ALIASES, MUSCLES, MUSCLE_LABEL, KIND_LABEL, LOAD_NOTE, DEFAULT_REST, SCHEMA, DEFAULT_DB, MIGRATIONS,
  clone, round1, today, daysAgo, addDays, byDateAsc, byDateDesc, hasRir, e1rm, bestE1rm, parseTarget, seedWeight,
  canon, exInfo, warmupFlags, bodyweightOn, effLoad, readEntry, sessionVolume, hardSetsByMuscle, liftSeries, liftSummary,
  parseTextPlan, extractPlanBlock, parseAnyPlan, b64urlEncode, b64urlDecode, b64EncodeUtf8,
  migrate, repoFiles, fromRepoFiles, buildDigest, gitBlobSha
};
if (typeof module !== 'undefined' && module.exports) module.exports = LiftCore;
if (typeof window !== 'undefined') window.LiftCore = LiftCore;
})();
