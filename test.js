/* Headless checks for the pure logic in core.js, including a golden test against the real log.
   Run: node test.js                                                                            */
'use strict';
const fs = require('fs');
const C = require('./core.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};
const ok = (name, cond) => eq(name, !!cond, true);
const iso = d => { const x = new Date(); x.setDate(x.getDate() - d); return C.today(x); };

console.log('\ne1RM (Epley)');
eq('225x5', C.e1rm(225, 5), 262.5);
eq('reps capped at 12', C.e1rm(100, 20), C.e1rm(100, 12));
eq('zero weight', C.e1rm(0, 8), 0);
eq('best of a set list', C.bestE1rm([{ w: 100, r: 5 }, { w: 120, r: 3 }, { w: 90, r: 10 }]), 132);

console.log('\ntarget parsing');
eq('full target', C.parseTarget('4x6-8 @2RIR 75lb rest 180'), { sets: 4, lo: 6, hi: 8, rir: 2, load: 75, unit: 'lb', rest: 180 });
eq('single rep count', C.parseTarget('3x15 @0RIR').hi, 15);
eq('negative load (assistance)', C.parseTarget('4x6-8 @2RIR -50lb').load, -50);
eq('rest in minutes', C.parseTarget('3x5 rest 3m').rest, 180);
eq('rest m:ss', C.parseTarget('3x5 rest 2:30').rest, 150);
eq('no load', C.seedWeight('3x10 @2RIR'), null);

console.log('\nnames, aliases, catalog');
eq('builtin alias', C.canon('Overhead Cable Tricep Extension', {}), 'Overhead Cable Extension');
eq('user alias', C.canon('Crunch Machine', { aliases: { 'Crunch Machine': 'Cable Crunch' } }), 'Cable Crunch');
eq('user can undo a builtin alias', C.canon('RDL', { aliases: { RDL: 'RDL' } }), 'RDL');
eq('alias chain', C.canon('A', { aliases: { A: 'B', B: 'Leg Press' } }), 'Leg Press');
ok('no infinite loop on cycles', C.canon('A', { aliases: { A: 'B', B: 'A' } }));
eq('unknown exercise marked', C.exInfo('Zercher Carry', {}).known, false);
eq('user classification', C.exInfo('Zercher Carry', { exercises: { 'Zercher Carry': { m: { abs: 1 }, kind: 'core' } } }).m, { abs: 1 });
eq('cable step 2.5 lb', C.exInfo('Cable Curl', { settings: { unit: 'lb' } }).step, 2.5);
eq('barbell step 5 lb', C.exInfo('Back Squat', { settings: { unit: 'lb' } }).step, 5);

console.log('\nwarm-ups');
const info = C.exInfo('Romanian Deadlift', {});
eq('leading light set guessed', C.warmupFlags([{ w: 135, r: 8, rir: 2 }, { w: 205, r: 8, rir: 2 }, { w: 205, r: 8, rir: 2 }], info), [true, false, false]);
eq('very easy leading set guessed', C.warmupFlags([{ w: 180, r: 13, rir: 4 }, { w: 220, r: 12, rir: 2 }], info), [true, false]);
eq('same-weight sets never guessed', C.warmupFlags([{ w: 120, r: 10, rir: 4 }, { w: 120, r: 12, rir: 4 }], info), [false, false]);
eq('back-off sets are not warm-ups', C.warmupFlags([{ w: 200, r: 5 }, { w: 140, r: 10 }], info), [false, false]);
eq('explicit flags win', C.warmupFlags([{ w: 135, r: 8, t: 'n' }, { w: 205, r: 8, t: 'w' }], info), [false, true]);
eq('bodyweight lifts not guessed', C.warmupFlags([{ w: 0, r: 5 }, { w: 25, r: 5 }], C.exInfo('Pull-Up', {})), [false, false]);

console.log('\nbodyweight loads');
const bwdb = { settings: { unit: 'lb' }, bodyweight: [{ date: '2026-08-01', w: 170 }], scans: [{ date: '2026-07-26', total_mass_lb: 174.2 }] };
eq('pull-up uses bodyweight + added', C.effLoad(bwdb, C.exInfo('Pull-Up', {}), 10, '2026-08-05'), 180);
eq('assisted subtracts assistance', C.effLoad(bwdb, C.exInfo('Assisted Pull-Up', {}), 50, '2026-08-05'), 120);
eq('falls back to scan mass before first weigh-in', C.bodyweightOn({ settings: {}, bodyweight: [], scans: bwdb.scans }, '2026-07-30'), 174.2);

console.log('\nvolume + weekly sets');
const sess = { date: iso(3), day: 'Upper A', ex: [
  { name: 'Flat Dumbbell Press', sets: [{ w: 40, r: 10, rir: 3 }, { w: 70, r: 8, rir: 2 }, { w: 70, r: 7, rir: 1 }, { w: 70, r: 6, rir: 1 }] },
  { name: 'Chest-Supported Row', sets: [{ w: 120, r: 10, rir: 2 }, { w: 120, r: 9, rir: 1 }, { w: 120, r: 8, rir: 1 }] },
  { name: 'Triceps Pushdown', sets: [{ w: 50, r: 14, rir: 1 }, { w: 50, r: 12, rir: 0 }, { w: 50, r: 0, rir: 0 }] },
  { name: 'Bulgarian Split Squat', sets: [{ w: 50, r: 10 }, { w: 50, r: 10 }] }
] };
eq('volume excludes warm-up and zero-rep sets', C.sessionVolume(sess, {}), 70 * 21 + 120 * 27 + 50 * 26 + 50 * 20);
const hs = C.hardSetsByMuscle([sess], {});
eq('chest: 3 working DB press sets', hs.chest, 3);
eq('triceps: 3*0.5 secondary + 2 direct', hs.tri, 3.5);
eq('per-side split squat counts as 1 set', hs.quad, 1);

console.log('\nplan parsing');
const p1 = C.parseTextPlan(`DAY: Upper A
FOCUS: horizontal push
NOTE: shoulder was cranky
Flat Dumbbell Press | 4x6-8 @2RIR 75lb rest 180 | pause at the bottom, rest 2 min if needed
Chest-Supported Row | 4x8-10 @2RIR 120lb`);
eq('day', p1.day, 'Upper A');
eq('exercise count', p1.ex.length, 2);
eq('rest from the target only, not the cue', p1.ex[0].rest, 180);
eq('no rest when absent', p1.ex[1].rest, undefined);
const p2 = C.parseTextPlan('**DAY:** Lower A\n1. Back Squat | 4x5-7 @2RIR 205lb\n- Romanian Deadlift | 3x8-10\n\n* Leg Press | 3x10-12 rest 150');
eq('markdown noise stripped', p2.ex.map(e => e.name), ['Back Squat', 'Romanian Deadlift', 'Leg Press']);
let threw = false; try { C.parseTextPlan('DAY: nothing here'); } catch (e) { threw = true; }
ok('empty plan rejected', threw);
const reply = 'Upper B today. OHP went 4x8 last time, so +5 lb.\n\n```\nDAY: Upper B\nOverhead Press | 4x6-8 @2RIR 80lb rest 180\nPull-Up | 4x6-8 @2RIR 0lb\n```\n';
const x = C.extractPlanBlock(reply);
eq('block extracted from a full reply', C.parseTextPlan(x.block).ex.length, 2);
ok('brief kept', x.brief.startsWith('Upper B today'));
eq('parseAnyPlan accepts the whole reply', C.parseAnyPlan(reply).day, 'Upper B');
eq('parseAnyPlan keeps the brief', !!C.parseAnyPlan(reply).brief, true);
const enc = C.b64urlEncode(p1);
eq('base64url round-trip', C.b64urlDecode(enc).ex[1].name, 'Chest-Supported Row');
eq('parseAnyPlan: #t= link', C.parseAnyPlan('https://x.github.io/liftlog/#t=' + encodeURIComponent('DAY: Upper B\nOverhead Press | 4x6-8')).ex[0].name, 'Overhead Press');
eq('utf-8 base64', Buffer.from(C.b64EncodeUtf8('café 100 kg'), 'base64').toString('utf8'), 'café 100 kg');

console.log('\nmigration: golden test against the real v1 log');
const log = JSON.parse(fs.readFileSync(fs.existsSync('data/log.json') ? 'data/log.json' : 'data/backup/log-v1.json', 'utf8'));
const m = C.migrate(log);
eq('schema is 2', m.v, 2);
eq('every session kept', m.sessions.length, log.sessions.length);
eq('sessions byte-identical', JSON.stringify(m.sessions), JSON.stringify(log.sessions));
eq('every set kept', m.sessions.reduce((n, s) => n + s.ex.reduce((k, e) => k + e.sets.length, 0), 0), log.sessions.reduce((n, s) => n + s.ex.reduce((k, e) => k + e.sets.length, 0), 0));
eq('profile untouched', JSON.stringify(m.profile), JSON.stringify(log.profile));
eq('coach notes kept', m.coachNotes, log.coachNotes);
eq('baseline DXA copied into scans', m.scans[0].body_fat_pct, 17.8);
ok('migrate is idempotent', JSON.stringify(C.migrate(m).sessions) === JSON.stringify(m.sessions) && C.migrate(m).scans.length === 1);
const localV1 = { v: 1, settings: { owner: 'o', repo: 'r', branch: 'main', token: 'tok', unit: 'lb', shas: { a: 1 } }, sessions: log.sessions, active: null, plan: null, bodyweight: [], coachNotes: 'x', dirty: true, profile: log.profile };
const lm = C.migrate(localV1);
eq('local settings kept', [lm.settings.owner, lm.settings.token, lm.settings.unit], ['o', 'tok', 'lb']);
eq('new settings defaulted', lm.settings.model, 'claude-sonnet-5');
eq('dirty flag kept', lm.dirty, true);
ok('input object not mutated', localV1.v === 1 && !localV1.scans);

console.log('\nrepo files round-trip');
const files = C.repoFiles(m);
ok('meta + one year file', files['data/meta.json'] && files['data/sessions/2026.json']);
const meta = JSON.parse(files['data/meta.json']);
eq('meta lists years', meta.years, ['2026']);
ok('token never written to the repo', !files['data/meta.json'].includes('tok') && !JSON.stringify(files).includes('"token"'));
const back = C.migrate(C.fromRepoFiles(meta, [JSON.parse(files['data/sessions/2026.json'])]));
eq('sessions survive the round trip', JSON.stringify(back.sessions), JSON.stringify(m.sessions.slice().sort(C.byDateAsc)));
const multi = C.repoFiles(Object.assign({}, m, { sessions: m.sessions.concat([{ id: 'y', date: '2027-01-03', day: 'Upper A', ex: [] }]) }));
ok('sessions split by year', multi['data/sessions/2027.json'] && JSON.parse(multi['data/meta.json']).years.length === 2);

console.log('\nreal-data sanity');
const series = C.liftSeries(m);
ok('tricep extension variants merged', series['Overhead Cable Extension'].length === 3 && !series['Overhead Cable Tricep Extension']);
ok('pull-ups have a real e1RM now', series['Assisted Pull-Up'][0].best > 150);
const rdl = series['Romanian Deadlift'];
eq('RDL 135 warm-up excluded from working sets', rdl[1].work, 4);
const d = C.buildDigest(m, '2026-08-27');
eq('digest schema', d.schema, 'liftlog/2');
eq('28-day session count', d.status.sessions_last_28d, 8);
ok('every muscle-credited set counts (no unknown names)', Object.keys(d.lifts).every(n => C.exInfo(n, m).known));
ok('lift series present', d.lifts['Leg Press'].series.length === 3);
ok('stall flag is boolean', typeof d.lifts['Chest-Supported Row'].stalled === 'boolean');
eq('logged_as recorded', d.lifts['Overhead Cable Extension'].logged_as, ['Overhead Cable Tricep Extension']);
ok('digest well under the old 38 KB file', JSON.stringify(d).length < 25000);
const sum = C.liftSummary(series['Leg Press'], '2026-08-27');
eq('leg press best', sum.best, 462);
eq('leg press PR sessions', sum.prIdx, [0, 1, 2]);

console.log('\ndigest windows');
const old = { settings: { unit: 'lb' }, profile: {}, bodyweight: [], scans: [], sessions: [] };
for (let i = 0; i < 60; i++) old.sessions.push({ id: 'o' + i, date: C.addDays('2025-01-06', i * 7), day: 'Lower A', ex: [{ name: 'Leg Press', sets: [{ w: 200 + i, r: 10 }] }] });
const d2 = C.buildDigest(old, C.addDays('2025-01-06', 59 * 7));
ok('recent 26 weeks kept per session', d2.lifts['Leg Press'].series.length <= 27);
ok('older months summarised', d2.lifts['Leg Press'].monthly_best_older.length >= 6);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
