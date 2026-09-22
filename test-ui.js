/* End-to-end test in a real DOM with a fake GitHub and a fake Claude API.
   Starts from a v1 phone database built from the real log, so the upgrade path is exercised.
   Run: npm i jsdom && node test-ui.js                                                        */
'use strict';
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const logV1Text = fs.existsSync(path.join(__dirname, 'data/log.json')) ? read('data/log.json') : read('data/backup/log-v1.json');
const logV1 = JSON.parse(logV1Text);
const gitSha = t => nodeCrypto.createHash('sha1').update('blob ' + Buffer.byteLength(t) + '\0').update(t).digest('hex');

/* ---- fake GitHub: refs, commits, trees, blobs ---- */
const gh = { head: 'c0', commits: { c0: { tree: 't0', parent: null, message: 'init' } }, trees: {}, blobs: {}, n: 0 };
function putTree(entries) { const id = 't' + (++gh.n); gh.trees[id] = entries; return id; }
function blob(text) { const s = gitSha(text); gh.blobs[s] = text; return s; }
gh.trees.t0 = ['COACH.md', 'data/program.json', 'data/index.json'].map(p => ({ path: p, type: 'blob', mode: '100644', sha: blob(read(p)) }))
  .concat([{ path: 'data/log.json', type: 'blob', mode: '100644', sha: blob(logV1Text) }]);
const repoFile = p => { const e = gh.trees[gh.commits[gh.head].tree].find(x => x.path === p); return e ? gh.blobs[e.sha] : null; };
function webEdit(p, text) {            // simulate an edit in GitHub's web editor
  const entries = gh.trees[gh.commits[gh.head].tree].filter(x => x.path !== p).concat([{ path: p, type: 'blob', mode: '100644', sha: blob(text) }]);
  const c = 'c' + (++gh.n); gh.commits[c] = { tree: putTree(entries), parent: gh.head, message: 'web edit' }; gh.head = c;
}
const resp = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
let claudeCalls = [];
async function fakeFetch(url, opts) {
  opts = opts || {};
  const u = new URL(url, 'https://x.github.io/liftlog/'); const m = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.hostname === 'api.anthropic.com') {
    claudeCalls.push({ headers: opts.headers, body });
    return resp(200, { content: [{ type: 'text', text: 'Lower B next. Leg press hit 4x12 so +10 lb.\n\n```\nDAY: Lower B\nFOCUS: hinge\nRomanian Deadlift | 4x6-8 @2RIR 215lb rest 180\nLeg Press | 4x10-12 @2RIR 340lb rest 150\n```' }] });
  }
  if (u.hostname !== 'api.github.com') {
    if (u.pathname.endsWith('program.json')) return resp(200, JSON.parse(read('data/program.json')));
    if (u.pathname.endsWith('COACH.md')) return resp(200, read('COACH.md'));
    return resp(404, 'nope');
  }
  const p = u.pathname.replace('/repos/o/liftlog', '');
  if (m === 'GET' && p === '/git/ref/heads/main') return resp(200, { object: { sha: gh.head } });
  if (m === 'GET' && p.startsWith('/git/commits/')) { const c = gh.commits[p.split('/').pop()]; return c ? resp(200, { tree: { sha: c.tree } }) : resp(404, {}); }
  if (m === 'GET' && p.startsWith('/git/trees/')) return resp(200, { tree: gh.trees[p.split('/').pop()] });
  if (m === 'POST' && p === '/git/trees') {
    let entries = gh.trees[body.base_tree].slice();
    body.tree.forEach(e => {
      entries = entries.filter(x => x.path !== e.path);
      if (e.sha === null) return;
      entries.push({ path: e.path, type: 'blob', mode: e.mode, sha: e.content !== undefined ? blob(e.content) : e.sha });
    });
    return resp(201, { sha: putTree(entries) });
  }
  if (m === 'POST' && p === '/git/commits') { const c = 'c' + (++gh.n); gh.commits[c] = { tree: body.tree, parent: body.parents[0], message: body.message }; return resp(201, { sha: c }); }
  if (m === 'PATCH' && p === '/git/refs/heads/main') {
    if (gh.commits[body.sha].parent !== gh.head) return resp(422, { message: 'not a fast forward' });
    gh.head = body.sha; return resp(200, {});
  }
  if (m === 'GET' && p.startsWith('/contents/')) { const t = repoFile(decodeURIComponent(p.slice(10))); return t === null ? resp(404, {}) : resp(200, t); }
  return resp(404, { message: 'unhandled ' + m + ' ' + p });
}

/* ---- boot the app on a phone that still has v1 data ---- */
const html = read('index.html');
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.github.io/liftlog/', pretendToBeVisual: true });
const w = dom.window;
w.fetch = fakeFetch;
Object.defineProperty(w, 'crypto', { value: nodeCrypto.webcrypto });
w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
let clip = '';
Object.defineProperty(w.navigator, 'clipboard', { value: { readText: async () => clip, writeText: async t => { clip = t; } } });
w.confirm = () => true;
w.scrollTo = () => {};
w.localStorage.setItem('liftlog.db.v1', JSON.stringify({
  v: 1, settings: { owner: 'o', repo: 'liftlog', branch: 'main', token: 'tok', unit: 'lb', shas: {} },
  profile: logV1.profile, program: logV1.program, sessions: logV1.sessions, active: null, plan: null,
  bodyweight: [], coachNotes: logV1.coachNotes, dirty: false, lastSync: '2026-08-27T21:52:18Z'
}));
for (const f of ['core.js', 'app.js']) { const s = w.document.createElement('script'); s.textContent = read(f); w.document.body.appendChild(s); }
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n));
const txt = () => w.document.querySelector('#main').textContent;
const click = elm => elm.dispatchEvent(new w.Event('click', { bubbles: true }));
const byText = (sel, t) => [...w.document.querySelectorAll(sel)].find(b => b.textContent.includes(t));
const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));
const $$ = s => [...w.document.querySelectorAll(s)];

(async () => {
  console.log('\nupgrade from v1');
  ok('migrated to v2', w.eval('db.v') === 2);
  ok('all 10 sessions kept', w.eval('db.sessions.length') === 10);
  ok('sessions identical to the v1 log', w.eval('JSON.stringify(db.sessions)') === JSON.stringify(logV1.sessions));
  ok('token kept', w.eval('db.settings.token') === 'tok');
  ok('v2 saved under the new key', JSON.parse(w.localStorage.getItem('liftlog.db')).v === 2);
  ok('v1 copy left in place', JSON.parse(w.localStorage.getItem('liftlog.db.v1')).v === 1);
  ok('four nav tabs', $$('.tab').length === 4);

  console.log('\npaste a full coach reply from the clipboard');
  clip = 'Upper B today. OHP 4x8 last time, +5 lb.\n\n```\nDAY: Upper B\nFOCUS: vertical push and pull\nOverhead Press | 4x6-8 @2RIR 80lb rest 180 | brace hard\nOverhead Cable Tricep Extension | 3x12-15 @1RIR 42.5lb rest 75\n```';
  click(byText('button', 'Paste plan')); await tick();
  ok('plan loaded', w.eval('db.plan && db.plan.day') === 'Upper B');
  ok('brief shown', txt().includes('OHP 4x8 last time'));
  ok('alias resolved in the plan view', txt().includes('Overhead Cable Extension'));
  ok('last performance shown', txt().includes('last '));

  console.log('\nrun the session');
  click(byText('button', 'Start session'));
  ok('session active', w.eval('!!db.active'));
  ok('exercise stored under canonical name', w.eval('db.active.ex[1].name') === 'Overhead Cable Extension');
  ok('cue rendered', txt().includes('brace hard'));
  ok('load convention shown', txt().includes('total incl. bar'));
  let vals = $$('.sval');
  ok('weight pre-filled from the plan', vals[0].value === '80');
  ok('reps pre-filled at top of range', vals[1].value === '8');
  ok('cable step is 2.5 lb', (() => { const v = $$('.sval')[3].value; click($$('.sbtn')[7]); const nv = $$('.sval')[3].value; return parseFloat(nv) - parseFloat(v) === 2.5; })());
  // warm-up set, then a working set typed on the keypad
  vals = $$('.sval'); vals[0].value = '45'; vals[0].dispatchEvent(new w.Event('change'));
  click($$('.warmbtn')[0]); click($$('.logbtn')[0]);
  ok('warm-up set recorded with flag', w.eval('db.active.ex[0].sets[0].t') === 'w');
  ok('set has a timestamp', !!w.eval('db.active.ex[0].sets[0].at'));
  ok('warm-up row labelled', $$('.setrow.warm').length === 1);
  vals = $$('.sval'); vals[0].value = '80'; vals[0].dispatchEvent(new w.Event('change'));
  click($$('.logbtn')[0]);
  ok('working set recorded', w.eval('db.active.ex[0].sets[1].w') === 80 && w.eval('db.active.ex[0].sets[1].t') === 'n');
  ok('rest timer uses the plan rest', w.eval('Math.round((restEnd - Date.now())/1000)') > 170);
  ok('next set seeded from the last one', $$('.sval')[0].value === '80');
  click($$('.logbtn')[0]); click($$('.logbtn')[0]);
  ok('progress chip shows 3/4', txt().includes('3/4'));
  // edit a set through the sheet
  click($$('.setrow')[1]);
  ok('edit sheet opened', !!w.document.querySelector('.sheet'));
  const sv = w.document.querySelectorAll('.sheet .sval'); sv[1].value = '9'; sv[1].dispatchEvent(new w.Event('change'));
  click(byText('.sheet button', 'Save'));
  ok('edited reps saved', w.eval('db.active.ex[0].sets[1].r') === 9);
  ok('sheet closed', !w.document.querySelector('.sheet'));
  click($$('.logbtn')[0]);
  ok('exercise collapses when done', !txt().includes('brace hard'));

  console.log('\nfinish and sync (atomic commit)');
  const before = gh.head;
  click(byText('button', 'Finish & sync'));
  await tick(200);
  ok('session stored', w.eval('db.sessions.length') === 11);
  ok('sync clean', w.eval('db.dirty') === false);
  ok('one new commit', gh.commits[gh.head].parent === before);
  ok('commit message names the session', /^session: /.test(gh.commits[gh.head].message));
  const meta = JSON.parse(repoFile('data/meta.json'));
  ok('meta.json written', meta.v === 2 && meta.years[0] === '2026');
  ok('no secrets in the repo', !repoFile('data/meta.json').includes('tok'));
  ok('sessions/2026.json has 11 sessions', JSON.parse(repoFile('data/sessions/2026.json')).sessions.length === 11);
  const dig = JSON.parse(repoFile('data/index.json'));
  ok('digest v2 written', dig.schema === 'liftlog/2');
  ok('digest excludes the warm-up', dig.recent_sessions[0].ex[0].sets[0][3] === 'w');
  ok('v1 log moved to backup unchanged', repoFile('data/backup/log-v1.json') === logV1Text);
  ok('v1 log.json removed', repoFile('data/log.json') === null);
  ok('COACH.md untouched', repoFile('COACH.md') === read('COACH.md'));

  console.log('\nsync after a web edit to COACH.md');
  webEdit('COACH.md', '# edited on github.com\n');
  w.eval('db.coachNotes = "No ab wheel access. Left knee dislikes lunges."; save(true);');
  await w.eval('syncNow(true)');
  ok('web edit preserved', repoFile('COACH.md') === '# edited on github.com\n');
  ok('new notes synced', JSON.parse(repoFile('data/meta.json')).coachNotes.includes('Left knee'));
  ok('backup not duplicated', repoFile('data/backup/log-v1.json') === logV1Text);

  console.log('\nrestore on a fresh phone');
  w.eval('db.sessions = []; db.dirty = false; save();');
  const headBefore = gh.head;
  ok('empty phone refuses to sync over history', (await w.eval('syncNow(true)')) === false && gh.head === headBefore);
  await w.eval('restoreFromGitHub()');
  ok('11 sessions restored', w.eval('db.sessions.length') === 11);
  ok('notes restored', w.eval('db.coachNotes').includes('Left knee'));

  console.log('\nper-lift pages');
  w.eval('go("stats")');
  ok('lift list rendered', txt().includes('Lower compounds') && txt().includes('Leg Press'));
  ok('sparklines drawn', $$('svg.spark').length > 5);
  ok('weekly sets card', txt().includes('warm-ups excluded'));
  ok('body comp card', txt().includes('Lean mass') && txt().includes('next retest'));
  click($$('.liftrow').find(r => r.textContent.includes('Leg Press')));
  ok('lift page opened', w.eval('route') === 'lift:Leg Press');
  ok('chart drawn', !!w.document.querySelector('.chart svg polyline'));
  ok('best e1RM tile', txt().includes('462'));
  ok('rep PRs listed', txt().includes('Best reps at each weight'));
  w.eval('go("lift:Hip Abduction")');
  ok('library exercise has no classify form', !txt().includes('Classify'));
  w.eval('db.sessions[0].ex.push({name:"Crunch Machine", sets:[{w:100,r:15}]}); go("lift:Crunch Machine")');
  ok('unknown exercise offers classification', txt().includes('Classify'));
  w.eval('db.aliases["Crunch Machine"] = "Cable Crunch"; go("lift:Cable Crunch")');
  ok('merged alias shows on target lift', txt().includes('Also logged as: Crunch Machine'));

  console.log('\nhistory editing');
  w.eval('go("history")');
  click(w.document.querySelector('.card.tap'));
  ok('session page opened', w.eval('route').startsWith('session:'));
  ok('warm-ups visible in session', txt().includes('warm-up'));

  console.log('\ncoach via API');
  w.eval('db.plan = null; db.settings.apiKey = "sk-test"; go("today")');
  const ask = byText('button', 'Ask the coach');
  ok('ask button appears with a key', !!ask);
  w.document.querySelector('#main input').value = 'only 45 minutes';
  click(ask); await tick(100);
  ok('Claude API called once', claudeCalls.length === 1);
  ok('browser-access header sent', claudeCalls[0].headers['anthropic-dangerous-direct-browser-access'] === 'true');
  ok('digest and note sent', claudeCalls[0].body.messages[0].content.includes('liftlog/2') && claudeCalls[0].body.messages[0].content.includes('only 45 minutes'));
  ok('COACH.md in the system prompt', claudeCalls[0].body.system.includes('edited on github.com'));
  ok('plan loaded from reply', w.eval('db.plan.day') === 'Lower B' && w.eval('db.plan.ex[0].rest') === 180);
  ok('brief kept', txt().includes('Leg press hit 4x12'));

  console.log('\nauto-finish a forgotten session');
  w.eval(`db.active = { id:'s9', date:'2026-09-20', day:'Upper A', start:new Date(Date.now()-5*3600e3).toISOString(), notes:'',
    ex:[{ name:'Lat Pulldown', target:'3x10-12', sets:[{w:125,r:12,rir:1,t:'n',at:new Date(Date.now()-4*3600e3).toISOString()}] }] };
    autoFinishStale();`);
  ok('stale session closed', w.eval('db.active') === null && w.eval('db.sessions.some(s => s.id === "s9")'));
  ok('end time = last set, not now', w.eval('Date.now() - new Date(db.sessions.find(s=>s.id==="s9").end).getTime()') > 3.9 * 3600e3);

  console.log('\nsettings');
  w.eval('go("settings")');
  ok('sync fields', txt().includes('GitHub sync'));
  ok('coach key field', txt().includes('Claude API key'));
  ok('scan list shows baseline', txt().includes('17.8%'));
  ok('format version shown', txt().includes('Data format v2'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
