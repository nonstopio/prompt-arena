// Exercises the chunked judging path with a stubbed model and database.
const fs = require('fs');
const src = fs.readFileSync('/home/claude/prompt-arena/src/index.js', 'utf8');

// Everything from the rubric down to (but not including) the route handler,
// plus the constants it relies on — read from source so the test cannot drift
// from the real penalty value.
// JUDGE_CHUNK already sits inside the sliced region, so only pull what is above it.
const constants = (src.match(/^const (BLUR_PENALTY|AWAY_GRACE|AWAY_STEP|AWAY_STEP_PENALTY) = .+$/gm) || []).join('\n');
const code = constants + '\n'
  + src.slice(src.indexOf('const RUBRIC ='), src.indexOf('export default {'))
  + '\nmodule.exports = { judgeRound, BLUR_PENALTY, AWAY_GRACE, AWAY_STEP, AWAY_STEP_PENALTY };';

const now = () => 1700000000;
const mod = { exports: {} };
new Function('module', 'now', 'console', code)(mod, now, console);
const { judgeRound, BLUR_PENALTY, AWAY_GRACE, AWAY_STEP, AWAY_STEP_PENALTY } = mod.exports;
console.log('penalty read from source: ' + BLUR_PENALTY + ' points per switch');

function makeEnv({ entries, scoreFor, winnerFrom = 0, breakChunk = -1 }) {
  const rows = entries;
  const writes = [];
  let chunkCalls = 0, winnerCalls = 0;

  const env = {
    JUDGE_MODEL: 'stub',
    AI: {
      run(_model, { messages, max_tokens }) {
        const user = messages[1].content;
        if (user.includes('"winnerId"')) {
          winnerCalls++;
          const ids = [...user.matchAll(/id=(\w+)/g)].map((m) => m[1]);
          return Promise.resolve({ response: JSON.stringify({
            winnerId: ids[winnerFrom], verdict: 'It named the fox, the snow and the film stock.' }) });
        }
        chunkCalls++;
        const ids = [...user.matchAll(/id=(\w+)/g)].map((m) => m[1]);
        if (chunkCalls === breakChunk) return Promise.resolve({ response: 'sorry, I cannot' });
        return Promise.resolve({ response: JSON.stringify({
          scores: ids.map((id) => {
            const total = scoreFor(id);
            // split the target total across the five parts, as the model would
            const w = [0.35, 0.20, 0.20, 0.15, 0.10];
            const [subject, setting, style, light, composition] = w.map((x) => Math.round(total * x * 10) / 10);
            return { id, subject, setting, style, light, composition, notes: 'note for ' + id };
          }) }) });
      },
    },
    DB: {
      prepare(sql) {
        const st = {
          sql, args: [],
          bind(...a) { st.args = a; return st; },
          run: () => Promise.resolve({}),
          all: () => {
            if (/FROM players/.test(sql)) {
              return Promise.resolve({ results: rows.map((e) => ({
                name_key: e.id, blur_count: e.blur || 0, away_penalty: e.idle || 0 })) });
            }
            if (/SELECT id, name_key FROM submissions/.test(sql)) {
              return Promise.resolve({ results: rows.map((e) => ({ id: e.id, name_key: e.id })) });
            }
            return Promise.resolve({ results: rows.map((e) => ({
              id: e.id, player_name: e.name, prompt: e.prompt,
              blur_count: e.blur || 0, away_penalty: e.idle || 0, away_since: null })) });
          },
        };
        return st;
      },
      batch(stmts) { stmts.forEach((st) => writes.push({ sql: st.sql, args: st.args })); return Promise.resolve(); },
    },
  };
  return { env, writes, stats: () => ({ chunkCalls, winnerCalls }) };
}

const mkEntries = (n, blurs = {}, idles = {}) => Array.from({ length: n }, (_, i) => ({
  id: 's' + (i + 1), name: 'Player ' + (i + 1), prompt: 'prompt number ' + (i + 1),
  blur: blurs['s' + (i + 1)] || 0, idle: idles['s' + (i + 1)] || 0,
}));

// Mirrors the server formula, read from the same constants.
const awayCost = (sec) =>
  Math.max(0, Math.floor((Math.max(0, sec) - AWAY_GRACE) / AWAY_STEP)) * AWAY_STEP_PENALTY;

const scoreOf = (writes, id) => {
  const w = writes.find((x) => x.sql.includes('UPDATE submissions') && x.args[3] === id);
  return w ? { final: w.args[0], raw: w.args[1] } : null;
};

const round = { id: 'r1', secret_prompt: 'a fox in deep snow, shot on 35mm film' };

const out = [];
const check = (label, pass, detail = '') => out.push([pass, label, detail]);

(async () => {
  // 1. a full room: every entry scored, none dropped
  {
    const entries = mkEntries(100);
    const { env, writes, stats } = makeEnv({ entries, scoreFor: (id) => 40 + (Number(id.slice(1)) % 50) });
    await judgeRound(env, round);
    const subWrites = writes.filter((w) => w.sql.includes('UPDATE submissions'));
    const zero = subWrites.filter((w) => w.args[0] === 0);
    const unscored = subWrites.filter((w) => String(w.args[1]).includes('Not scored'));
    check('100 entries all written', subWrites.length === 100, `${subWrites.length} writes`);
    check('  none fell through to "Not scored"', unscored.length === 0, `${unscored.length} unscored`);
    check('  none silently zeroed', zero.length === 0, `${zero.length} zeros`);
    check('  scored in 4 chunks of 25', stats().chunkCalls === 4, `${stats().chunkCalls} chunk calls`);
    check('  one winner call', stats().winnerCalls === 1, `${stats().winnerCalls} winner calls`);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('  a winner was chosen', Boolean(roundWrite.args[1]), String(roundWrite.args[1]));
    check('  verdict stored', String(roundWrite.args[2]).length > 20);
  }

  // 2. one chunk refuses: its retry covers it, nobody is lost
  {
    const entries = mkEntries(50);
    const { env, writes, stats } = makeEnv({ entries, scoreFor: () => 60, breakChunk: 2 });
    await judgeRound(env, round);
    const subWrites = writes.filter((w) => w.sql.includes('UPDATE submissions'));
    const unscored = subWrites.filter((w) => String(w.args[1]).includes('Not scored'));
    check('a refused chunk is retried', stats().chunkCalls === 3, `${stats().chunkCalls} chunk calls for 2 chunks`);
    check('  still nobody unscored', unscored.length === 0, `${unscored.length} unscored`);
  }

  // 3. everyone scores zero: no winner
  {
    const entries = mkEntries(30);
    const { env, writes, stats } = makeEnv({ entries, scoreFor: () => 0 });
    await judgeRound(env, round);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('all-zero round has no winner', roundWrite.args[1] === null, String(roundWrite.args[1]));
    check('  verdict explains it', String(roundWrite.args[2]).includes('no winner'));
    check('  no winner call was wasted', stats().winnerCalls === 0, `${stats().winnerCalls} winner calls`);
  }

  // 4. a single entry still publishes
  {
    const entries = mkEntries(1);
    const { env, writes, stats } = makeEnv({ entries, scoreFor: () => 71 });
    await judgeRound(env, round);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('one entry becomes the winner', roundWrite.args[1] === 's1', String(roundWrite.args[1]));
    check('  no winner call needed', stats().winnerCalls === 0, `${stats().winnerCalls} winner calls`);
    check('  a verdict is still written', String(roundWrite.args[2]).length > 20);
  }

  // 5. the winner must be the top scorer, not a mid-table pick the model names
  {
    const entries = mkEntries(30);
    const { env, writes } = makeEnv({ entries, scoreFor: (id) => (id === 's7' ? 95 : 30), winnerFrom: 0 });
    await judgeRound(env, round);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('winner comes from the finalists', roundWrite.args[1] === 's7', String(roundWrite.args[1]));
  }

  // ---- 6. the tab-switch penalty ----------------------------------------
  {
    const entries = mkEntries(4, { s2: 3, s3: 1, s4: 20 });
    const { env, writes } = makeEnv({ entries, scoreFor: (id) => (id === 's4' ? 10 : 70) });
    await judgeRound(env, round);
    check('clean entry keeps its score', JSON.stringify(scoreOf(writes, 's1')) === '{"final":70,"raw":70}',
      JSON.stringify(scoreOf(writes, 's1')));
    check('  3 switches costs 15', JSON.stringify(scoreOf(writes, 's2')) === '{"final":55,"raw":70}',
      JSON.stringify(scoreOf(writes, 's2')));
    check('  1 switch costs 5', JSON.stringify(scoreOf(writes, 's3')) === '{"final":65,"raw":70}',
      JSON.stringify(scoreOf(writes, 's3')));
    check('  score floors at zero, never negative', scoreOf(writes, 's4').final === 0,
      JSON.stringify(scoreOf(writes, 's4')));
  }

  // ---- 7. the penalty can change who wins -------------------------------
  {
    const entries = mkEntries(2, { s1: 4 });
    const { env, writes } = makeEnv({ entries, scoreFor: (id) => (id === 's1' ? 70 : 55) });
    await judgeRound(env, round);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('penalty decides the win when it should', roundWrite.args[1] === 's2',
      `70-20=50 vs 55 -> winner ${roundWrite.args[1]}`);
  }

  // ---- 8. a big lead survives a few switches ----------------------------
  {
    const entries = mkEntries(2, { s1: 3 });
    const { env, writes } = makeEnv({ entries, scoreFor: (id) => (id === 's1' ? 70 : 40) });
    await judgeRound(env, round);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('a 30-point lead is not overturned by 3 switches', roundWrite.args[1] === 's1',
      `70-15=55 vs 40 -> winner ${roundWrite.args[1]}`);
  }

  // ---- 9. tie goes to whoever stayed on the tab -------------------------
  {
    const entries = mkEntries(2, { s1: 2, s2: 0 });
    const { env, writes } = makeEnv({ entries, scoreFor: (id) => (id === 's1' ? 70 : 60) });
    await judgeRound(env, round);
    const roundWrite = writes.find((w) => w.sql.includes('UPDATE rounds'));
    check('a tie goes to the one who stayed', roundWrite.args[1] === 's2',
      `70-10=60 vs 60 -> winner ${roundWrite.args[1]}`);
  }

  // ---- 10. the long-absence penalty --------------------------------------
  {
    check('under a minute away is free', awayCost(59) === 0, `59s -> ${awayCost(59)}`);
    check('  exactly a minute is free', awayCost(60) === 0, `60s -> ${awayCost(60)}`);
    check('  75s costs 5', awayCost(75) === 5, `75s -> ${awayCost(75)}`);
    check('  90s costs 10', awayCost(90) === 10, `90s -> ${awayCost(90)}`);
    check('  the worked example: 1m30 total is 15', 5 + awayCost(90) === 15, `5 + ${awayCost(90)}`);
    check('  3 minutes costs 40', awayCost(180) === 40, `180s -> ${awayCost(180)}`);
  }

  // ---- 11. both penalties come off the score -----------------------------
  {
    const entries = mkEntries(2, { s1: 1 }, { s1: 10 });
    const { env, writes } = makeEnv({ entries, scoreFor: () => 80 });
    await judgeRound(env, round);
    check('switch and absence both deducted',
      JSON.stringify(scoreOf(writes, 's1')) === '{"final":65,"raw":80}',
      '80 - 5 (switch) - 10 (away) -> ' + JSON.stringify(scoreOf(writes, 's1')));
    check('  a clean entry is untouched',
      JSON.stringify(scoreOf(writes, 's2')) === '{"final":80,"raw":80}');
  }

  // ---- 12. absence alone cannot go negative ------------------------------
  {
    const entries = mkEntries(1, {}, { s1: 500 });
    const { env, writes } = makeEnv({ entries, scoreFor: () => 30 });
    await judgeRound(env, round);
    check('absence penalty floors at zero', scoreOf(writes, 's1').final === 0,
      JSON.stringify(scoreOf(writes, 's1')));
  }

  // ---- 13. a switch recorded while the judge is running still counts -------
  {
    const entries = mkEntries(1);
    const { env, writes } = makeEnv({ entries, scoreFor: () => 60 });
    // the player leaves the tab after the first read but before the write
    const realRun = env.AI.run.bind(env.AI);
    env.AI.run = (m, o) => { entries[0].blur = 2; return realRun(m, o); };
    await judgeRound(env, round);
    check('a late switch still reaches the score',
      JSON.stringify(scoreOf(writes, 's1')) === '{"final":50,"raw":60}',
      '60 - 10 -> ' + JSON.stringify(scoreOf(writes, 's1')));
  }

  // ---- 14. scores carry one decimal, built from the rubric parts ---------
  {
    const entries = mkEntries(1);
    const { env, writes } = makeEnv({ entries, scoreFor: () => 0 });
    env.AI.run = (m, { messages }) => {
      if (messages[1].content.includes('winnerId')) {
        return Promise.resolve({ response: JSON.stringify({ winnerId: 's1', verdict: 'v' }) });
      }
      return Promise.resolve({ response: JSON.stringify({ scores: [
        { id: 's1', subject: 28.4, setting: 12.7, style: 9.3, light: 6.8, composition: 4.2, notes: 'n' },
      ] }) });
    };
    await judgeRound(env, round);
    check('total is summed from the parts to one decimal',
      scoreOf(writes, 's1').raw === 61.4, 'expected 61.4, got ' + scoreOf(writes, 's1').raw);
  }

  // ---- 15. a part outside its ceiling is clamped -------------------------
  {
    const entries = mkEntries(1);
    const { env, writes } = makeEnv({ entries, scoreFor: () => 0 });
    env.AI.run = (m, { messages }) => {
      if (messages[1].content.includes('winnerId')) {
        return Promise.resolve({ response: JSON.stringify({ winnerId: 's1', verdict: 'v' }) });
      }
      return Promise.resolve({ response: JSON.stringify({ scores: [
        { id: 's1', subject: 90, setting: 20, style: 20, light: 15, composition: 10, notes: 'n' },
      ] }) });
    };
    await judgeRound(env, round);
    check('an over-max part is clamped to its ceiling',
      scoreOf(writes, 's1').raw === 100, 'subject 90 capped at 35 -> ' + scoreOf(writes, 's1').raw);
  }

  // ---- 16. an old-style plain score still works --------------------------
  {
    const entries = mkEntries(1);
    const { env, writes } = makeEnv({ entries, scoreFor: () => 0 });
    env.AI.run = (m, { messages }) => {
      if (messages[1].content.includes('winnerId')) {
        return Promise.resolve({ response: JSON.stringify({ winnerId: 's1', verdict: 'v' }) });
      }
      return Promise.resolve({ response: JSON.stringify({ scores: [{ id: 's1', score: 72.5, notes: 'n' }] }) });
    };
    await judgeRound(env, round);
    check('falls back to a plain score if parts are missing',
      scoreOf(writes, 's1').raw === 72.5, String(scoreOf(writes, 's1').raw));
  }

  // ---- 17. penalties keep the decimal ------------------------------------
  {
    const entries = mkEntries(1, { s1: 1 });
    const { env, writes } = makeEnv({ entries, scoreFor: () => 0 });
    env.AI.run = (m, { messages }) => {
      if (messages[1].content.includes('winnerId')) {
        return Promise.resolve({ response: JSON.stringify({ winnerId: 's1', verdict: 'v' }) });
      }
      return Promise.resolve({ response: JSON.stringify({ scores: [
        { id: 's1', subject: 28.4, setting: 12.7, style: 9.3, light: 6.8, composition: 4.2, notes: 'n' },
      ] }) });
    };
    await judgeRound(env, round);
    check('penalty subtracts cleanly from a decimal score',
      scoreOf(writes, 's1').final === 56.4, '61.4 - 5 -> ' + scoreOf(writes, 's1').final);
  }

  console.log('');
  for (const [pass, label, detail] of out) {
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  }
  console.log('\n' + out.filter((r) => r[0]).length + '/' + out.length + ' passing');
})();
