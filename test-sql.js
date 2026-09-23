/**
 * Drives the Worker's routes with a database that parses every statement for
 * real, against the real schema. The stubs in the other suites never parse SQL,
 * so a typo like a trailing comma before FROM sails through them and only
 * surfaces in production.
 *
 *   node test-sql.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIR = __dirname;
const db = new DatabaseSync(':memory:');

// Real schema, minus the DROPs at the top. exec() takes the whole file, so
// trailing comments do not become their own incomplete statement.
db.exec(
  fs.readFileSync(path.join(DIR, 'schema.sql'), 'utf8')
    .split('\n').filter((l) => !/^\s*DROP/i.test(l)).join('\n')
);

const seen = new Set();
const bad = [];

function makeStatement(sql) {
  seen.add(sql);
  let prepared;
  try {
    prepared = db.prepare(sql);
  } catch (err) {
    bad.push({ sql, error: err.message });
  }
  const st = {
    sql,
    bind(...args) { st.args = args; return st; },
    all() { try { return Promise.resolve({ results: prepared ? prepared.all(...(st.args || [])) : [] }); } catch { return Promise.resolve({ results: [] }); } },
    first() { try { return Promise.resolve(prepared ? prepared.get(...(st.args || [])) || null : null); } catch { return Promise.resolve(null); } },
    run() { try { if (prepared) prepared.run(...(st.args || [])); } catch { /* data, not syntax */ } return Promise.resolve({}); },
  };
  return st;
}

const env = {
  ADMIN_KEY: 'k',
  ASSETS: { fetch: () => new Response('', { headers: { 'content-type': 'text/html' } }) },
  AI: {
    run(model) {
      if (String(model).includes('flux')) return Promise.resolve({ image: 'AAAA' });
      return Promise.resolve({ response: JSON.stringify({ scores: [], winnerId: null, verdict: 'v' }) });
    },
  },
  DB: {
    prepare: makeStatement,
    batch(stmts) { stmts.forEach((s) => s.run()); return Promise.resolve(); },
  },
};

const admin = { 'x-admin-key': 'k', 'content-type': 'application/json' };
const json = { 'content-type': 'application/json' };

const routes = [
  ['GET',  '/api/state?name=rushi&from=r0'],
  ['GET',  '/api/image?kind=target&id=r1&name=rushi'],
  ['GET',  '/api/image?kind=sub&id=s1'],
  ['POST', '/api/join',   { name: 'Rushi' }],
  ['POST', '/api/draft',  { name: 'Rushi', prompt: 'a fox' }],
  ['POST', '/api/flag',   { name: 'Rushi' }],
  ['POST', '/api/back',   { name: 'Rushi' }],
  ['POST', '/api/submit', { name: 'Rushi', prompt: 'a fox in snow' }],
  ['POST', '/api/update', { name: 'Rushi', prompt: 'a silver fox' }],
  ['GET',  '/api/results'],
  ['GET',  '/api/admin/state', null, admin],
  ['GET',  '/api/admin/rounds?status=all&page=0', null, admin],
  ['GET',  '/api/admin/rounds?status=aborted&page=1', null, admin],
  ['GET',  '/api/admin/round?id=r1', null, admin],
  ['GET',  '/api/admin/storage', null, admin],
  ['POST', '/api/admin/generate', {}, admin],
  ['POST', '/api/admin/start',    {}, admin],
  ['POST', '/api/admin/render',   {}, admin],
  ['POST', '/api/admin/close',    {}, admin],
  ['POST', '/api/admin/judge',    {}, admin],
  ['POST', '/api/admin/session',  {}, admin],
  ['POST', '/api/admin/discard',  {}, admin],
];

(async () => {
  // Load the worker as an ES module.
  const tmp = path.join(DIR, '.sqlcheck.mjs');
  fs.writeFileSync(tmp, fs.readFileSync(path.join(DIR, 'src/index.js'), 'utf8'));
  const mod = await import('file://' + tmp);
  const worker = mod.default;

  // A round and a player to exercise the joins against.
  db.exec("INSERT INTO rounds (id, secret_prompt, image_b64, status, created_at, started_at, ends_at) VALUES ('r1','a fox','AAA','live',1,1,9999999999)");
  db.exec("INSERT INTO players (round_id, name_key, player_name, joined_at, blur_count, away_penalty) VALUES ('r1','rushi','Rushi',1,2,10)");
  db.exec("INSERT INTO submissions (id, round_id, player_name, name_key, prompt, image_b64, created_at, edits) VALUES ('s1','r1','Rushi','rushi','a fox','AAA',2,0)");

  // Many routes branch on round status and return early, so the run is repeated
  // in each state. A statement the run never reaches is a statement never checked.
  for (const status of ['live', 'closed', 'published', 'aborted', 'draft']) {
    db.exec(`UPDATE rounds SET status = '${status}', judged_at = 3, winner_id = 's1'`);
    for (const [method, url, body, headers] of routes) {
      const req = new Request('https://x.test' + url, {
        method,
        headers: headers || (body ? json : undefined),
        body: body ? JSON.stringify(body) : undefined,
      });
      try { await worker.fetch(req, env); } catch { /* route errors are not our concern here */ }
    }
  }

  fs.unlinkSync(tmp);

  console.log(`\nparsed ${seen.size} distinct SQL statements across ${routes.length} routes in 5 round states\n`);
  if (!bad.length) {
    console.log('PASS  every statement is valid SQLite');
    console.log('\n1/1 passing');
    process.exit(0);
  }
  for (const b of bad) {
    console.log('FAIL  ' + b.error);
    console.log('      ' + b.sql.replace(/\s+/g, ' ').slice(0, 160));
  }
  console.log(`\n0/1 passing — ${bad.length} broken statement${bad.length === 1 ? '' : 's'}`);
  process.exit(1);
})();
