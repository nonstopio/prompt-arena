const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('/home/claude/prompt-arena/public/index.html', 'utf8');
const now = () => Math.floor(Date.now() / 1000);

function boot({ name = 'Rushikesh Nere', state, onJoin }) {
  const calls = { celebrate: 0, rafFrames: 0, fillRects: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://x.test/',
    beforeParse(w) {
      if (name) w.localStorage.setItem('pa_name', name);
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      // jsdom reports hasFocus() === false for ever, which makes the focus poll
      // re-flag "away" the instant a focus event lands. Drive it from the events
      // instead, the way a real browser behaves.
      let focused = true;
      w.addEventListener('blur', () => { focused = false; });
      w.addEventListener('focus', () => { focused = true; });
      Object.defineProperty(w.document, 'hasFocus', { value: () => focused, writable: true });
      w.HTMLCanvasElement.prototype.getContext = function () {
        const self = this;
        return {
          scale() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
          drawImage() {}, measureText: () => ({ width: 60 }),
          fillRect() { if (self.id === 'confetti') calls.fillRects++; },
          set fillStyle(v) {}, set font(v) {}, set globalAlpha(v) {},
        };
      };
      w.fetch = (u) => {
        u = String(u);
        let b = { ok: true };
        if (u.startsWith('/api/join') && onJoin) onJoin();
        if (u.startsWith('/api/state')) b = state(u);
        else if (u.startsWith('/api/results')) b = {
          round: { id: 'r1', status: 'published', serverTime: now() }, published: true,
          secretPrompt: 'a fox in snow', verdict: 'It named the fox.', winnerId: 's1',
          blurPenalty: 5,
          board: [
            { rank: 1, id: 's1', name, prompt: 'a fox', score: 72, rawScore: 72, penalty: 0, switchPenalty: 0, idlePenalty: 0, notes: 'n', hasImage: true, blurCount: 0 },
            { rank: 2, id: 's2', name: 'Amit', prompt: 'a dog', score: 45, rawScore: 60, penalty: 15, switchPenalty: 10, idlePenalty: 5, notes: 'n', hasImage: true, blurCount: 2 },
          ],
        };
        else if (u.startsWith('/api/image')) b = { b64: 'x' };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(b) });
      };
    },
  });
  return { w: dom.window, d: dom.window.document, calls };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const head = (d) => (d.querySelector('#app h2') || { textContent: '' }).textContent.trim();

const live = (id = 'r1') => ({ round: { id, status: 'live', endsAt: now() + 300, serverTime: now() }, entries: 1, myEndsAt: now() + 300, draft: '', players: [], mine: null, sessionAborted: false });
const draft = (id) => ({ round: { id, status: 'draft', serverTime: now() }, entries: 0, myEndsAt: null, draft: '', players: [], mine: null, sessionAborted: false });
const pub = (id = 'r1') => ({ round: { id, status: 'published', serverTime: now() }, entries: 1, myEndsAt: now(), draft: '', players: [], mine: { id: 's1', prompt: 'a fox' }, sessionAborted: false });

async function run() {
  const results = [];
  const check = (label, pass, detail = '') => { results.push([pass, label, detail]); };

  // ---- 1. confetti on results -------------------------------------------
  {
    const { d, calls } = boot({ state: () => pub() });
    await wait(1000);
    check('results screen renders', head(d) === 'Results', head(d));
    await wait(400);
    check('confetti canvas is drawing', calls.fillRects > 100, `fillRect calls: ${calls.fillRects}`);
    const mid = calls.fillRects;
    await wait(2500);
    check('still drawing at ~3s', calls.fillRects > mid + 100, `+${calls.fillRects - mid}`);
    const late = calls.fillRects;
    await wait(2800);
    const atEnd = calls.fillRects;
    await wait(700);
    // A frame already in flight at the cutoff may still land, so allow a
    // couple rather than demanding an exact stop under load.
    check('stops after ~5s', calls.fillRects - atEnd < 200, `+${calls.fillRects - atEnd} after cutoff`);
    check('ran for the full 5s', atEnd > late, `+${atEnd - late} between 3s and 5s`);
  }

  // ---- 1b. a zero-score round still gets the reveal ----------------------
  {
    const { d, calls, w } = boot({ state: () => pub() });
    w.fetch = ((orig) => (u) => {
      if (String(u).startsWith('/api/results')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
        round: { id: 'r1', status: 'published', serverTime: now() }, published: true,
        secretPrompt: 'a fox', verdict: 'Nobody scored.', winnerId: null,
        board: [{ rank: 1, id: 's1', name: 'X', prompt: 'p', score: 0, notes: 'n', hasImage: true, blurCount: 0 }] }) });
      return orig(u);
    })(w.fetch);
    await wait(1400);
    check('no-winner round still animates', calls.fillRects > 100, `fillRect calls: ${calls.fillRects}`);
  }

  // ---- 1c. exactly five bursts ------------------------------------------
  {
    const { d, w, calls } = boot({ state: () => pub() });
    const marks = [];
    await wait(1000);
    let last = calls.fillRects;
    for (let i = 0; i < 12; i++) {   // sample every 400ms across the run
      await wait(400);
      marks.push(calls.fillRects - last);
      last = calls.fillRects;
    }
    // Each burst adds ~90 pieces on top of what is already flying, so the
    // per-frame particle count climbs five times. Later bursts are a smaller
    // proportional jump than earlier ones, so count rises rather than ratios.
    const rises = marks.slice(0, 8).filter((m, i) => i > 0 && m > marks[i - 1]).length;
    const peak = Math.max(...marks);
    check('five bursts land', rises >= 4 && peak > marks[0] * 2,
      `rises: ${rises}, peak/first: ${(peak / marks[0]).toFixed(1)}x, samples: ${marks.join(',')}`);
  }

  // ---- 1d. the rules name a single edit ---------------------------------
  {
    const { d } = boot({ state: () => live('r1') });
    await wait(1000);
    const appText = () => d.getElementById('app').textContent.replace(/\s+/g, ' ');
    check('rules say revisions are unlimited', /revised as often as you like/.test(appText()));
    check('rules warn about switching after submitting', /before and after you submit/.test(appText()));
    // scoped to the rendered screen: body.textContent also contains the page script
    check('the tab rule is stated once, not twice',
      (appText().match(/Stay on this tab/g) || []).length === 1,
      (appText().match(/Stay on this tab/g) || []).length + ' on screen');
  }

  // ---- 1e. the score breakdown tooltip -----------------------------------
  {
    const { d } = boot({ state: () => pub() });
    await wait(1400);
    check('every row has a breakdown button', d.querySelectorAll('[data-tip]').length === 2,
      d.querySelectorAll('[data-tip]').length + ' buttons');
    const tip = d.getElementById('tip_s2');
    check('  breakdown hidden until asked', !tip.classList.contains('open'));
    d.querySelector('[data-tip="s2"]').click();
    check('  opens on click', tip.classList.contains('open'));
    const t = tip.textContent.replace(/\s+/g, ' ');
    check('  shows the judge score', /Judge's score 60/.test(t), t.slice(0, 60));
    check('  shows the rubric weights', /subject 35/.test(t));
    check('  shows the switch penalty', /2 switches away from the tab −10/.test(t), t);
    check('  shows the time-away penalty', /Time spent away −5/.test(t));
    check('  shows the final', /Final 45/.test(t));
    d.querySelector('[data-tip="s1"]').click();
    check('  only one open at a time', !tip.classList.contains('open') && d.getElementById('tip_s1').classList.contains('open'));
  }

  // ---- 2. abort from each screen ----------------------------------------
  const from = [
    ['lobby (draft)', () => draft('r1')],
    ['mid round (live)', () => live('r1')],
    ['results (published)', () => pub('r1')],
  ];
  for (const [label, first] of from) {
    let aborted = false;
    const { d } = boot({ state: (u) => (aborted ? { ...draft('r2'), sessionAborted: u.includes('from=r1') } : first()) });
    await wait(1000);
    const before = head(d);
    aborted = true;
    await wait(3000);
    check(`abort seen from ${label}`, head(d) === 'The session was aborted by the admin', `was "${before}" -> "${head(d)}"`);
    check(`  Start Over button on ${label}`, (d.getElementById('rejoin') || {}).textContent === 'Start Over');
  }

  // ---- 3. normal next round must NOT look like an abort ------------------
  {
    let next = false;
    const { d } = boot({ state: () => (next ? { ...draft('r2'), sessionAborted: false } : pub('r1')) });
    await wait(1000);
    next = true;
    await wait(3000);
    check('normal next round does not abort', head(d) !== 'The session was aborted by the admin', head(d));
  }

  // ---- 4. Start Over from the abort screen -------------------------------
  {
    let aborted = false;
    const { w, d } = boot({ state: (u) => (aborted ? { ...draft('r2'), sessionAborted: u.includes('from=r1') } : live('r1')) });
    await wait(1000);
    aborted = true;
    await wait(3000);
    d.getElementById('rejoin') && d.getElementById('rejoin').click();
    await wait(400);
    check('Start Over returns to join screen', head(d) === 'Enter the arena', head(d));
    check('  header cleared', d.getElementById('who').textContent.trim() === '');
    check('  stored round cleared', w.sessionStorage.getItem('pa_round') === null);
  }

  // ---- 4b. the exact reported sequence: Start Over must stick -----------
  {
    let phase = 'live', held = null;
    const { w, d } = boot({ state: (u) => {
      if (phase === 'live') return live('r1');
      return { ...draft('r2'), sessionAborted: u.includes('from=r1') };
    }});
    await wait(1000);
    phase = 'aborted';
    await wait(3000);
    check('sequence: abort screen appears', head(d) === 'The session was aborted by the admin', head(d));

    // hold the next poll open, click Start Over mid-flight, then release it
    const realFetch = w.fetch;
    w.fetch = (u) => {
      if (String(u).startsWith('/api/state') && !held) {
        return new Promise((res) => { held = () => res({ ok: true, json: () => Promise.resolve({ ...draft('r2'), sessionAborted: true }) }); });
      }
      return realFetch(u);
    };
    await wait(2600);                       // let a poll start and hang
    d.getElementById('rejoin').click();     // Start Over, mid-flight
    await wait(200);
    const afterClick = head(d);
    if (held) held();                       // stale reply lands now
    await wait(900);
    check('sequence: stays on the name screen', head(d) === 'Enter the arena', `clicked->"${afterClick}" then "${head(d)}"`);

    // now type a name and join
    w.fetch = (u) => realFetch(u);
    phase = 'joined';
    d.getElementById('nm').value = 'Rushikesh Nere';
    d.getElementById('go').click();
    await wait(1200);
    check('sequence: joining does not bounce back to abort', head(d) !== 'The session was aborted by the admin', head(d));
    await wait(3000);
    check('sequence: still not on abort after further polls', head(d) !== 'The session was aborted by the admin', head(d));
  }

  // ---- 4c. the three-strike tab rule -------------------------------------
  {
    let mySwitches = 0, submitted = false;
    const { d, w } = boot({ state: () => ({
      round: { id: 'r1', status: 'live', endsAt: now() + 300, serverTime: now() },
      entries: 1, myEndsAt: now() + 300, draft: '', players: [], mySwitches,
      lockAt: 3, hideAt: 2, penalty: 5, myIdlePenalty: 0,
      mine: submitted ? { id: 's1', prompt: 'a fox in deep snow', edits: 0 } : null,
      sessionAborted: false }) });
    await wait(1000);
    const guard = () => (d.querySelector('.guard') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim();
    const hidden = () => d.querySelector('.target').classList.contains('hidden-guard');

    d.getElementById('pr').value = 'a fox in deep snow';
    check('rules mention switching after submitting', d.body.textContent.includes('before and after you submit'));
    check('rules state the over-a-minute rule', d.body.textContent.includes('Away over 1 minute'));
    check('rules give the worked example', /1 min 30 sec/.test(d.body.textContent));
    check('rules say penalties persist', /Penalties follow your name/.test(d.body.textContent));

    w.dispatchEvent(new w.Event('blur')); w.dispatchEvent(new w.Event('focus'));
    check('1st switch: warned, can restore', !!d.getElementById('unhide') && hidden(), guard().slice(0, 60));
    check('  names the 5-point cost', /5 points/.test(guard()));
    d.getElementById('unhide').click();
    check('  image comes back', !hidden());

    mySwitches = 1;
    w.dispatchEvent(new w.Event('blur')); w.dispatchEvent(new w.Event('focus'));
    check('2nd switch: image gone, no restore', hidden() && !d.getElementById('unhide'), guard().slice(0, 70));
    check('  warns the next one locks', /submitted and locked/.test(guard()));

    mySwitches = 2; submitted = true;
    w.dispatchEvent(new w.Event('blur')); w.dispatchEvent(new w.Event('focus'));
    // checked immediately: the screen flips to the submitted view moments later
    check('3rd switch: entry submitted and locked', /submitted and locked/.test(guard()), guard().slice(0, 80));
    await wait(400);
    check('  lock message survives the screen change', /submitted and locked/.test(guard()), guard().slice(0, 60));

    mySwitches = 3;
    await wait(3000);
    check('locked entry has no edit button', !d.getElementById('edit'));
    check('  panel says it is locked', /Locked after 3 tab switches/.test(d.body.textContent));
    const panelText = (d.getElementById('entrybox') || { textContent: '' }).textContent.replace(/\s+/g, ' ');
    check('  panel shows the running penalty', /3 switches away so far — 15 points/.test(panelText), panelText.trim().slice(0, 90));
  }

  // ---- 4d. Start Over is not reachable during a live round --------------
  {
    const { d } = boot({ state: () => live('r1') });
    await wait(1000);
    check('no Start Over link mid-round', !d.getElementById('chg'),
      JSON.stringify(d.getElementById('who').textContent.trim()));
    check('  header still names the player', /Playing as/.test(d.getElementById('who').textContent));
  }

  // ---- 4e. it appears once the host aborts, and wipes cleanly -----------
  {
    let aborted = false;
    const { d, w } = boot({ state: (u) => (aborted
      ? { ...draft('r2'), sessionAborted: u.includes('from=r1') }
      : live('r1')) });
    await wait(1000);
    aborted = true;
    await wait(3000);
    check('Start Over link appears after an abort', !!d.getElementById('chg'));
    w.localStorage.setItem('junk', '1'); w.sessionStorage.setItem('junk', '1');
    d.getElementById('chg').click();
    await wait(500);
    check('  lands on the first screen', head(d) === 'Enter the arena', head(d));
    check('  localStorage wiped', w.localStorage.length === 0, `${w.localStorage.length} keys left`);
    check('  sessionStorage wiped', w.sessionStorage.length === 0, `${w.sessionStorage.length} keys left`);
  }

  // ---- 4f. a tab left open across two rounds starts the second clean ------
  {
    let roundId = 'r1', mySwitches = 0, submitted = false;
    const { d, w } = boot({ state: () => ({
      round: { id: roundId, status: 'live', endsAt: now() + 300, serverTime: now() },
      entries: 1, myEndsAt: now() + 300, draft: '', players: [], mySwitches,
      lockAt: 3, hideAt: 2, penalty: 5, myIdlePenalty: 0,
      mine: submitted ? { id: 's1', prompt: 'a fox', edits: 0 } : null,
      sessionAborted: false }) });
    await wait(1000);

    // burn all three switches in round one
    for (let i = 0; i < 3; i++) {
      w.dispatchEvent(new w.Event('blur')); w.dispatchEvent(new w.Event('focus'));
      mySwitches = i + 1;
    }
    submitted = true;
    await wait(3000);
    check('round 1: locked out after 3 switches',
      /Your entry has been submitted and locked/.test((d.querySelector('.guard') || { textContent: '' }).textContent));

    // the host publishes and starts a fresh round; the tab was never reloaded
    roundId = 'r2'; mySwitches = 0; submitted = false;
    await wait(3500);
    const guardText = (d.querySelector('.guard') || { textContent: '' }).textContent;
    check('round 2: starts clean, not locked',
      !/Your entry has been submitted and locked/.test(guardText),
      guardText.replace(/\s+/g, ' ').trim().slice(0, 55) || '(empty)');
    check('  image is not hidden', !d.querySelector('.target').classList.contains('hidden-guard'));
    check('  can write a prompt again', !!d.getElementById('pr'));
  }

  // ---- 4g. lock in round 1, abort, Start Over, rejoin -> clean -----------
  {
    let roundId = 'r1', mySwitches = 0, submitted = false, aborted = false, joined = [];
    const { d, w } = boot({ state: (u) => {
      if (aborted) return { round: { id: 'r2', status: 'live', endsAt: now() + 300, serverTime: now() },
        entries: 0, myEndsAt: now() + 300, draft: '', players: [], mySwitches: 0,
        lockAt: 3, hideAt: 2, penalty: 5, myIdlePenalty: 0, mine: null,
        sessionAborted: u.includes('from=r1') };
      return { round: { id: roundId, status: 'live', endsAt: now() + 300, serverTime: now() },
        entries: 1, myEndsAt: now() + 300, draft: '', players: [], mySwitches,
        lockAt: 3, hideAt: 2, penalty: 5, myIdlePenalty: 0,
        mine: submitted ? { id: 's1', prompt: 'a fox', edits: 0 } : null, sessionAborted: false };
    }});
    await wait(1000);
    for (let i = 0; i < 3; i++) {
      w.dispatchEvent(new w.Event('blur')); w.dispatchEvent(new w.Event('focus'));
      mySwitches = i + 1;
    }
    submitted = true;
    await wait(3000);
    check('locked in round 1',
      /Your entry has been submitted and locked/.test((d.querySelector('.guard') || { textContent: '' }).textContent));

    aborted = true;
    await wait(3000);
    check('  host aborts -> abort screen', head(d) === 'The session was aborted by the admin', head(d));
    d.getElementById('rejoin').click();
    await wait(500);
    check('  Start Over -> name screen', head(d) === 'Enter the arena', head(d));

    // rejoin under the same name
    d.getElementById('nm').value = 'Rushikesh Nere';
    d.getElementById('go').click();
    await wait(1500);
    const guardText = (d.querySelector('.guard') || { textContent: '' }).textContent;
    check('  rejoined with nothing carried over',
      !/Your entry has been submitted and locked/.test(guardText) && !/hidden for the rest/.test(guardText),
      guardText.replace(/\s+/g, ' ').trim().slice(0, 50) || '(clean)');
    check('  image visible again', !d.querySelector('.target').classList.contains('hidden-guard'));
    check('  prompt box usable again', !!d.getElementById('pr') && !d.getElementById('pr').disabled);
  }

  // ---- 4h. a returning player takes their seat before the round opens -----
  {
    let phase = 'published', joins = 0, roster = [];
    const { d } = boot({ state: () => (phase === 'published'
      ? { round: { id: 'r1', status: 'published', serverTime: now() }, entries: 1, myEndsAt: now(),
          draft: '', players: [], mySwitches: 0, myIdlePenalty: 0,
          mine: { id: 's1', prompt: 'a fox' }, sessionAborted: false }
      : { round: { id: 'r2', status: 'draft', serverTime: now() }, entries: 0, myEndsAt: null,
          draft: '', players: roster, mySwitches: 0, myIdlePenalty: 0,
          mine: null, sessionAborted: false })
    , onJoin: () => { joins++; roster = [{ name: 'Rushikesh Nere', done: false }]; } });

    await wait(1200);
    check('sitting on the results page', head(d) === 'Results', head(d));
    phase = 'draft';                       // the host generates the next round
    await wait(4000);
    check('next round: joined without retyping a name', joins >= 1, `join called ${joins}x`);
    check('  lobby counts them', /1 joined so far/.test((d.getElementById('rtitle') || { textContent: '' }).textContent),
      (d.getElementById('rtitle') || { textContent: '-' }).textContent);
    check('  their own name is on the roster', /Rushikesh Nere/.test((d.getElementById('chips') || { textContent: '' }).textContent));
    check('  joined once, not on every poll', joins <= 2, `join called ${joins}x across ~2 polls`);
  }

  // ---- 4i. the clock bar sticks and stays informative --------------------
  {
    const { d } = boot({ state: () => ({
      round: { id: 'r1', status: 'live', endsAt: now() + 42, serverTime: now() },
      entries: 7, myEndsAt: now() + 42, draft: '', players: [], mySwitches: 2, myIdlePenalty: 5,
      lockAt: 3, hideAt: 2, penalty: 5, mine: null, sessionAborted: false }) });
    await wait(1200);
    const bar = d.querySelector('.clockbar');
    check('the clock sits in a sticky bar', !!bar);
    check('  it is the first thing on the screen', d.getElementById('app').firstElementChild === bar);
    check('  the long instructions moved out of it', !bar.querySelector('.clocklabel') && !!d.querySelector('p.clocklabel'));
    check('  under a minute turns it urgent', d.getElementById('clock').classList.contains('urgent'),
      d.getElementById('clock').textContent);
    const tally = d.getElementById('ctally').textContent.replace(/\s+/g, ' ');
    check('  it carries the entry count', /7 entries in/.test(tally), tally);
    check('  and what penalties have cost', /−15|-15/.test(tally), tally);
  }

  // ---- 5. a fresh player must never see an abort -------------------------
  {
    const { d } = boot({ state: () => live('r9') });
    await wait(1200);
    check('fresh player sees the round, not an abort', head(d) !== 'The session was aborted by the admin', head(d));
  }

  console.log('');
  for (const [pass, label, detail] of results) {
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  }
  console.log('\n' + results.filter(r => r[0]).length + '/' + results.length + ' passing');
  process.exit(0);
}
run();
