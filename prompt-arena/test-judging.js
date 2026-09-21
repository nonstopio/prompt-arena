// Exercises the chunked judging path with a stubbed model and database.
const fs = require('fs');
const src = fs.readFileSync('/home/claude/prompt-arena/src/index.js', 'utf8');

// Everything from the rubric down to (but not including) the route handler.
const code = src.slice(src.indexOf('const RUBRIC ='), src.indexOf('export default {'))
  + '\nmodule.exports = { judgeRound };';

const now = () => 1700000000;
const mod = { exports: {} };
new Function('module', 'now', 'console', code)(mod, now, console);
const { judgeRound } = mod.exports;

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
          scores: ids.map((id) => ({ id, score: scoreFor(id), notes: 'note for ' + id })) }) });
      },
    },
    DB: {
      prepare(sql) {
        const st = {
          sql, args: [],
          bind(...a) { st.args = a; return st; },
          all: () => Promise.resolve({ results: rows.map((e) => ({ id: e.id, player_name: e.name, prompt: e.prompt })) }),
        };
        return st;
      },
      batch(stmts) { stmts.forEach((st) => writes.push({ sql: st.sql, args: st.args })); return Promise.resolve(); },
    },
  };
  return { env, writes, stats: () => ({ chunkCalls, winnerCalls }) };
}

const mkEntries = (n) => Array.from({ length: n }, (_, i) => ({
  id: 's' + (i + 1), name: 'Player ' + (i + 1), prompt: 'prompt number ' + (i + 1),
}));

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

  console.log('');
  for (const [pass, label, detail] of out) {
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  }
  console.log('\n' + out.filter((r) => r[0]).length + '/' + out.length + ' passing');
})();
