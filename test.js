/* Headless checks for the pure logic in app.js.  Run: node test.js  */
'use strict';
// minimal DOM/storage shims so app.js can be require()d outside a browser
const store = {};
global.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = v, removeItem: k => delete store[k] };
global.document = { addEventListener() {}, querySelector: () => ({ dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, textContent: '' }), querySelectorAll: () => [], createElement: () => ({ classList: { add() {} }, appendChild() {}, style: {} }) };
global.window = { addEventListener() {} };
global.location = { hash: '', pathname: '/', href: '/' };
global.history = { replaceState() {} };
global.fetch = () => Promise.reject(new Error('no network in tests'));

const A = require('./app.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};
const ok = (name, cond) => eq(name, !!cond, true);

console.log('\ne1RM (Epley)');
eq('225x5', A.e1rm(225, 5), 262.5);
eq('100x1 = 100', A.e1rm(100, 1), 103.3);
eq('reps capped at 12', A.e1rm(100, 20), A.e1rm(100, 12));
eq('zero weight', A.e1rm(0, 8), 0);
eq('best of a set list', A.bestE1rm([{ w: 100, r: 5 }, { w: 120, r: 3 }, { w: 90, r: 10 }]), 132);

console.log('\nvolume + weekly sets');
const sess = {
  date: '2026-07-27', day: 'Upper A', ex: [
    { name: 'Flat Dumbbell Press', sets: [{ w: 70, r: 8, rir: 2 }, { w: 70, r: 7, rir: 1 }, { w: 70, r: 6, rir: 1 }, { w: 70, r: 6, rir: 0 }] },
    { name: 'Chest-Supported Row', sets: [{ w: 120, r: 10, rir: 2 }, { w: 120, r: 9, rir: 1 }, { w: 120, r: 8, rir: 1 }] },
    { name: 'Triceps Pushdown', sets: [{ w: 50, r: 14, rir: 1 }, { w: 50, r: 12, rir: 0 }, { w: 50, r: 0, rir: 0 }] }
  ]
};
eq('session volume', A.sessionVolume(sess), 70 * 27 + 120 * 27 + 50 * 26);
const hs = A.hardSetsByMuscle([sess]);
eq('chest sets', hs.chest, 4);
eq('back sets', hs.back, 3);
// DB press contributes 4 x 0.5 as a secondary; pushdown contributes its 2 completed sets
// (the third has 0 reps and must be ignored). Rows are back/biceps, not triceps.
eq('triceps: 4*0.5 secondary + 2 direct', hs.tri, 4);
eq('biceps: rows only, 3*0.5', hs.bi, 1.5);
eq('zero-rep set excluded', hs.tri, 4);          // would be 5 if the empty pushdown set counted

console.log('\ntext plan parser');
const p1 = A.parseTextPlan(`DAY: Upper A
FOCUS: horizontal push
NOTE: shoulder was cranky
Flat Dumbbell Press | 4x6-8 @2RIR 75lb | pause at the bottom
Chest-Supported Row | 4x8-10 @2RIR 120lb`);
eq('day', p1.day, 'Upper A');
eq('focus', p1.focus, 'horizontal push');
eq('note', p1.notes, 'shoulder was cranky');
eq('exercise count', p1.ex.length, 2);
eq('name', p1.ex[0].name, 'Flat Dumbbell Press');
eq('target', p1.ex[0].target, '4x6-8 @2RIR 75lb');
eq('cue', p1.ex[0].cue, 'pause at the bottom');
eq('seed weight parsed', A.seedWeight(p1.ex[0].target), 75);
eq('seed weight absent', A.seedWeight('3x10 @2RIR'), null);

const p2 = A.parseTextPlan(`**DAY:** Lower A
1. Back Squat | 4x5-7 @2RIR 205lb
- Romanian Deadlift | 3x8-10 @2RIR 155lb

* Leg Press | 3x10-12 rest 150`);
eq('markdown noise stripped', p2.ex.map(e => e.name), ['Back Squat', 'Romanian Deadlift', 'Leg Press']);
eq('bold day header', p2.day, 'Lower A');
eq('rest parsed', p2.ex[2].rest, 150);
eq('bare exercise, no target', p2.ex[2].target, '3x10-12 rest 150');

let threw = false; try { A.parseTextPlan('DAY: nothing here'); } catch (e) { threw = true; }
ok('empty plan rejected', threw);

console.log('\nplan transport round-trips');
const enc = A.b64urlEncode(p1);
eq('base64url round-trip', A.b64urlDecode(enc).ex[1].name, 'Chest-Supported Row');
ok('base64url is url-safe', !/[+/=]/.test(enc));
eq('parseAnyPlan: json', A.parseAnyPlan(JSON.stringify(p1)).day, 'Upper A');
eq('parseAnyPlan: #plan= link', A.parseAnyPlan('https://x.github.io/liftlog/#plan=' + enc).day, 'Upper A');
eq('parseAnyPlan: #t= link', A.parseAnyPlan('https://x.github.io/liftlog/#t=' + encodeURIComponent('DAY: Upper B\nOverhead Press | 4x6-8 @2RIR 95lb')).ex[0].name, 'Overhead Press');
eq('parseAnyPlan: raw text', A.parseAnyPlan('DAY: Lower B\nHip Thrust | 3x8-10').ex.length, 1);
eq('utf-8 safe base64 for GitHub', typeof A.b64EncodeUtf8('café — 100 kg'), 'string');
eq('utf-8 decodes back', Buffer.from(A.b64EncodeUtf8('café — 100 kg'), 'base64').toString('utf8'), 'café — 100 kg');

console.log('\ndigest');
const iso = d => { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
const db = {
  settings: { unit: 'lb' },
  profile: { goal: 'recomp' },
  coachNotes: 'left shoulder',
  bodyweight: [{ date: iso(1), w: 174.2 }],
  plan: null,
  sessions: [
    Object.assign({}, sess, { id: 'a', date: iso(14) }),
    Object.assign({}, sess, {
      id: 'b', date: iso(7), ex: [{ name: 'Flat Dumbbell Press', sets: [{ w: 75, r: 8, rir: 2 }, { w: 75, r: 7, rir: 1 }] }]
    }),
    Object.assign({}, sess, { id: 'c', date: iso(60) })   // outside the 28-day window
  ]
};
const d = A.buildDigest(db);
eq('schema', d.schema, 'liftlog/1');
eq('coach notes carried', d.coach_notes, 'left shoulder');
eq('28-day session count excludes old', d.status.sessions_last_28d, 2);
eq('last session date', d.status.last_session_date, iso(7));
eq('days since last', d.status.days_since_last, 7);
eq('best e1rm picks the heavier day', d.lifts['Flat Dumbbell Press'].best_e1rm, A.e1rm(75, 8));
eq('best e1rm dated correctly', d.lifts['Flat Dumbbell Press'].best_date, iso(7));
eq('lift history newest first', d.lifts['Flat Dumbbell Press'].history[0].date, iso(7));
eq('history capped at 4', d.lifts['Flat Dumbbell Press'].history.length <= 4, true);
eq('recent sessions capped at 10', d.recent_sessions.length <= 10, true);
eq('recent sessions newest first', d.recent_sessions[0].date, iso(7));
eq('sets compacted to triples', d.recent_sessions[0].ex[0].sets[0], [75, 8, 2]);
eq('weekly chest sets = (4+2)/4', d.status.weekly_sets_by_muscle_28d.chest, 1.5);
eq('bodyweight passed through', d.status.bodyweight_recent.length, 1);
ok('digest is compact', JSON.stringify(d).length < 8000);

console.log('\ndaysAgo');
eq('same day', A.daysAgo(iso(0)), 0);
eq('a week', A.daysAgo(iso(7)), 7);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
