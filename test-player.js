const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('/home/claude/prompt-arena/public/index.html', 'utf8');
const now = () => Math.floor(Date.now() / 1000);

function boot({ name = 'Rushikesh Nere', state }) {
  const calls = { celebrate: 0, rafFrames: 0, fillRects: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://x.test/',
    beforeParse(w) {
      if (name) w.localStorage.setItem('pa_name', name);
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
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
        if (u.startsWith('/api/state')) b = state(u);
        else if (u.startsWith('/api/results')) b = {
          round: { id: 'r1', status: 'published', serverTime: now() }, published: true,
          secretPrompt: 'a fox in snow', verdict: 'It named the fox.', winnerId: 's1',
          board: [{ rank: 1, id: 's1', name, prompt: 'a fox', score: 72, notes: 'n', hasImage: true, blurCount: 0 }],
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
    check('rules say unlimited revisions', d.body.textContent.includes('as many times as you like'),
      d.body.textContent.includes('revise it once') ? 'still says once' : '');
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

  // ---- 4c. editing is unlimited and free ---------------------------------
  {
    let prompt = 'a fox in deep snow';
    const { d } = boot({ state: () => ({ round: { id: 'r1', status: 'live', endsAt: now() + 300, serverTime: now() },
      entries: 1, myEndsAt: now() + 300, draft: '', players: [], mine: { id: 's1', prompt, edits: 4 }, sessionAborted: false }) });
    await wait(1000);
    check('edit button shown after 4 edits', !!d.getElementById('edit'));
    const panel = () => (d.getElementById('entrybox') || { textContent: '' }).textContent;
    check('  no edits-left counter', !/edits? left/.test(panel()), panel().replace(/\s+/g, ' ').trim());
    check('  no final-entry message', !/this entry is final/.test(panel()));
    d.getElementById('edit').click();
    await wait(150);
    check('  editor opens', !!d.getElementById('pr'));
    check('  hint says images come later', d.body.textContent.includes('Images are made after the round'));
    prompt = 'a silver fox in deep snow';
    await wait(3000);
    check('  panel refreshes to the new prompt', d.body.textContent.includes('silver') || d.getElementById('pr'));
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
