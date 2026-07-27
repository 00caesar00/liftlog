/* End-to-end smoke test in a real DOM: load a plan, run a session, check the digest.
   Run: npm i jsdom && node test-ui.js                                              */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.github.io/liftlog/', pretendToBeVisual: true });
const w = dom.window;
w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(__dirname, 'data/program.json'), 'utf8'))) });
// inject as a real script so top-level declarations land in global scope, as in a browser
const s = w.document.createElement('script');
s.textContent = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
w.document.body.appendChild(s);
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n));
const txt = () => w.document.querySelector('#main').textContent;

console.log('\ninitial render');
ok('app rendered something', txt().length > 20);
ok('offers to start from the program', /Start .* from program|Ask the coach/.test(txt()));
ok('four nav tabs', w.document.querySelectorAll('.tab').length === 4);

console.log('\nload a coach plan');
w.eval(`db.plan = parseTextPlan(\`DAY: Upper A
FOCUS: horizontal push
Flat Dumbbell Press | 4x6-8 @2RIR 75lb | pause at the bottom
Chest-Supported Row | 4x8-10 @2RIR 120lb\`); save(true); render();`);
ok('plan title shown', txt().includes('Upper A'));
ok('exercises shown', txt().includes('Flat Dumbbell Press') && txt().includes('Chest-Supported Row'));
ok('target shown', txt().includes('4x6-8 @2RIR 75lb'));

console.log('\nrun the session');
w.eval('startSession(db.plan);');
ok('session is active', w.eval('!!db.active'));
ok('cue rendered', txt().includes('pause at the bottom'));
const steppers = w.document.querySelectorAll('.stepper');
ok('steppers rendered for each exercise', steppers.length === 6);
ok('weight pre-filled from the plan', w.document.querySelectorAll('.sval')[0].textContent === '75');
ok('reps pre-filled from the rep range', w.document.querySelectorAll('.sval')[1].textContent === '8');

// tap: + on weight, then Log set
w.document.querySelectorAll('.sbtn')[1].dispatchEvent(new w.Event('click'));   // weight +5
w.document.querySelector('.logbtn').dispatchEvent(new w.Event('click'));
ok('set recorded', w.eval('db.active.ex[0].sets.length') === 1);
ok('stepped weight used', w.eval('db.active.ex[0].sets[0].w') === 80);
ok('set row visible', txt().includes('80 lb'));
ok('rest timer running', w.document.querySelector('#rest').classList.contains('show'));
ok('e1RM displayed', txt().includes('e1RM'));

// second set carries the previous set forward
ok('next set seeded from the last one', w.document.querySelectorAll('.sval')[0].textContent === '80');
w.document.querySelector('.logbtn').dispatchEvent(new w.Event('click'));
ok('second set recorded', w.eval('db.active.ex[0].sets.length') === 2);

console.log('\nfinish and digest');
w.eval('db.settings.owner="";');            // no sync in tests
w.eval('const a=db.active; a.end=new Date().toISOString(); a.ex=a.ex.filter(e=>e.sets.length); db.sessions.push(a); db.active=null; db.plan=null; save(true);');
w.eval('render();');
ok('one session stored', w.eval('db.sessions.length') === 1);
ok('empty exercises dropped', w.eval('db.sessions[0].ex.length') === 1);
const digest = JSON.parse(w.eval('JSON.stringify(buildDigest(db))'));
ok('digest lists the lift', !!digest.lifts['Flat Dumbbell Press']);
ok('digest has e1RM', digest.lifts['Flat Dumbbell Press'].best_e1rm > 0);
ok('digest counts the session', digest.status.sessions_last_28d === 1);
ok('digest stays small', JSON.stringify(digest).length < 6000);

console.log('\nhistory + stats views render');
w.eval('route="history"; render();');
ok('history shows the session', txt().includes('Flat Dumbbell Press'));
w.eval('route="stats"; render();');
ok('stats shows weekly sets', txt().includes('Chest'));
ok('stats shows e1RM bests', txt().includes('Estimated 1RM'));
w.eval('route="settings"; render();');
ok('settings shows sync fields', txt().includes('GitHub sync'));

console.log('\npersistence');
ok('written to localStorage', (w.localStorage.getItem('liftlog.db.v1') || '').includes('Flat Dumbbell Press'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
