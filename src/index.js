/**
 * Prompt Arena — a live prompt-writing competition.
 *
 * Admin generates a round: the server invents a random hidden prompt, renders it
 * with FLUX.1 schnell, and that image becomes the question. Everyone gets the same
 * one. Players write the prompt they think made it; each submission is rendered too,
 * so the results wall shows what everyone actually produced. A language model scores
 * every entry against the hidden prompt and explains the win.
 *
 * Everything runs inside Cloudflare's free daily allowance.
 */

// ---------------------------------------------------------------------------
// The random prompt generator. One pick per row, assembled into a scene.
// ---------------------------------------------------------------------------

const SEEDS = {
  subject: [
    'a lighthouse keeper', 'an origami crane', 'a rusting carousel horse',
    'a snow leopard', 'a glass greenhouse', 'a vintage diving helmet',
    'a hot air balloon', 'a koi fish', 'a grand piano', 'a red telephone box',
    'a beekeeper in full veil', 'a paper boat', 'a mechanical owl',
    'a cluster of wild mushrooms', 'a derelict fishing trawler',
    'a violin maker at the bench', 'a stack of weathered books',
    'a hummingbird mid-flight', 'a spiral staircase', 'a fox',
    'an antique brass telescope', 'a bowl of pomegranates', 'a sleeping cat',
    'a wooden sailboat', 'a street cellist', 'a terracotta water jug',
    'a swarm of fireflies', 'an old stone bridge', 'a chess set mid-game',
    'a potter at the wheel',
  ],
  setting: [
    'on a windswept cliff edge', 'inside an abandoned train station',
    'in a flooded marble hall', 'on a quiet rooftop above the city',
    'deep in a bamboo forest', 'in a cramped clockmaker\u2019s workshop',
    'on a frozen lake', 'inside a sunlit library', 'in a desert canyon',
    'on a rain-slicked cobblestone street', 'beneath a coral reef',
    'in a field of tall wheat', 'inside a cathedral of glass',
    'on the deck of a ship at sea', 'in a neon-lit alley after rain',
    'among ancient moss-covered ruins', 'in a rooftop garden',
    'inside a vast empty warehouse', 'on a mountain pass in fog',
    'in a crowded night market',
  ],
  light: [
    'lit by a single shaft of morning light', 'under heavy storm clouds',
    'at golden hour', 'in cold blue twilight', 'backlit by a low sun',
    'under flickering candlelight', 'in bright overcast daylight',
    'lit only by moonlight', 'with warm lamplight pooling on the floor',
    'in harsh midday sun with hard shadows', 'through drifting fog',
    'lit by rippling light reflected off water', 'under a sky of stars',
    'with soft diffused window light', 'lit by distant city glow',
  ],
  style: [
    'shot on 35mm film', 'as a detailed watercolour painting',
    'as a flat vector illustration', 'in the style of a charcoal sketch',
    'as a moody oil painting', 'as a high-detail 3D render',
    'as a Japanese woodblock print', 'as a pen and ink drawing with cross-hatching',
    'as a soft pastel illustration', 'as a cinematic film still',
    'as a hand-painted gouache illustration', 'as a stark black and white photograph',
    'as a low-poly 3D scene', 'as a copperplate etching',
    'as a children\u2019s picture book illustration',
  ],
  composition: [
    'extreme close-up', 'wide establishing shot', 'shot from low to the ground',
    'symmetrical head-on framing', 'overhead top-down view',
    'shallow depth of field with the background thrown out of focus',
    'the subject small against a vast background', 'tight portrait crop',
    'viewed through a doorway', 'a long lens compressing the scene',
    'dutch angle', 'reflected in a mirror',
  ],
  palette: [
    'muted earth tones', 'a cold teal and grey palette',
    'saturated warm reds and oranges', 'pale desaturated pastels',
    'deep greens and gold', 'high contrast monochrome',
    'dusty pinks and cream', 'inky blues with a single warm highlight',
    'sun-bleached ochre and white', 'rich jewel tones',
  ],
  mood: [
    'quiet and still', 'tense and foreboding', 'warm and nostalgic',
    'lonely and vast', 'playful and bright', 'solemn and reverent',
    'dreamlike and uncertain', 'energetic and chaotic',
    'melancholy', 'serene',
  ],
  detail: [
    'with dust motes hanging in the air', 'with rain streaking the surfaces',
    'with wildflowers pushing through the cracks', 'with steam rising gently',
    'with a flock of birds scattering', 'with peeling paint and visible wear',
    'with fresh snow settling on every edge', 'with long shadows stretching away',
    'with scattered fallen leaves', 'with cobwebs catching the light',
    'with a thin layer of mist near the ground', 'with wind visibly moving everything',
  ],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function composePrompt() {
  return [
    `${pick(SEEDS.composition)} of ${pick(SEEDS.subject)} ${pick(SEEDS.setting)}`,
    pick(SEEDS.light),
    pick(SEEDS.detail),
    pick(SEEDS.style),
    pick(SEEDS.palette),
    `${pick(SEEDS.mood)} mood`,
  ].join(', ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID().slice(0, 8);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (message, status = 400) => json({ error: message }, status);

/**
 * The model occasionally refuses a prompt or returns nothing, which used to
 * leave an entry with no picture on the results wall. Try again, then try a
 * neutrally reworded version, before giving up.
 */
async function renderWithRetry(env, prompt, steps) {
  const attempts = [
    prompt,
    prompt,
    `A tasteful illustration. ${prompt}`,
  ];
  for (const attempt of attempts) {
    try {
      const out = await renderImage(env, attempt, steps);
      if (out) return out;
    } catch { /* try the next wording */ }
  }
  return null;
}

// The question image is studied for five minutes, so it is rendered at full
// quality. Entry thumbnails sit beside it for comparison and read perfectly
// well at half the diffusion steps, for two thirds of the cost.
const TARGET_STEPS = 4;
const ENTRY_STEPS = 2;

async function renderImage(env, prompt, steps) {
  // Only `prompt` and `steps` are accepted — passing anything else (including
  // `seed`, which still appears in Cloudflare's code samples) fails with 5006.
  const out = await env.AI.run(env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell', {
    prompt,
    steps: steps || TARGET_STEPS,
  });
  if (!out || !out.image) throw new Error('The image model returned nothing.');
  return out.image; // base64 jpeg
}

const roundSeconds = (env) => Number(env.ROUND_SECONDS || 300);

// Images are made after the round, not as people submit, so revising costs
// nothing and there is no reason to limit it.
const MAX_EDITS = Infinity;

// Images rendered per request when preparing results. Cloudflare allows 50
// subrequests per request on the free plan and a render may retry twice, so
// ten is the safe ceiling.
const RENDER_BATCH = 10;

// Points deducted per trip away from the tab during a live round. The final
// score is floored at zero, so interruptions can never push anyone negative.
const BLUR_PENALTY = 5;

// Trips away from the tab: the first warns, the second costs the image for the
// round, the third submits whatever they have and locks it.
const BLUR_HIDE_FOREVER = 2;
const BLUR_LOCK_ENTRY = 3;

// A long absence costs more than a glance. Nothing extra for the first minute,
// then five points for every fifteen seconds beyond it. Timed on the server
// clock, so the page cannot under-report it.
const AWAY_GRACE = 60;
const AWAY_STEP = 15;
const AWAY_STEP_PENALTY = 5;

const awayCost = (seconds) =>
  Math.max(0, Math.floor((Math.max(0, seconds) - AWAY_GRACE) / AWAY_STEP)) * AWAY_STEP_PENALTY;

// A short window past the deadline so a browser's automatic submit still lands.
const GRACE = 20;

/**
 * Every player shares one deadline, set when the host opens the round, so the
 * clock starts at the same instant for the whole room. The round closes itself
 * once the grace window for late-arriving auto-submits has passed.
 */
async function settle(env, round) {
  if (round && round.status === 'live' && round.ends_at && now() >= round.ends_at + GRACE) {
    await sweepDrafts(env, round);
    await env.DB.prepare('UPDATE rounds SET status = ? WHERE id = ?').bind('closed', round.id).run();
    round.status = 'closed';
  }
  return round;
}

/**
 * Turns saved drafts into real entries for anyone whose browser never submitted
 * — a closed tab, a dead battery, a lost connection. Renders run in parallel
 * batches so a roomful of stragglers still finishes in one pass.
 */
async function sweepDrafts(env, round) {
  const { results: stragglers } = await env.DB.prepare(
    'SELECT p.name_key, p.player_name, p.draft FROM players p ' +
    'WHERE p.round_id = ? AND p.draft IS NOT NULL AND length(trim(p.draft)) >= 3 ' +
    'AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.round_id = p.round_id AND s.name_key = p.name_key)'
  ).bind(round.id).all();

  for (let i = 0; i < stragglers.length; i += 40) {
    const batch = stragglers.slice(i, i + 40);
    await env.DB.batch(
      batch.map((p) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO submissions (id, round_id, player_name, name_key, prompt, image_b64, created_at) VALUES (?,?,?,?,?,?,?)'
        ).bind(id(), round.id, p.player_name, p.name_key, p.draft.trim().slice(0, 1200), null, now())
      )
    );
  }
}

async function currentRound(env) {
  const round = await env.DB.prepare(
    'SELECT * FROM rounds ORDER BY created_at DESC LIMIT 1'
  ).first();
  return settle(env, round);
}

function publicRound(round) {
  if (!round) return null;
  return {
    id: round.id,
    status: round.status,
    startedAt: Number(round.started_at) || null,
    endsAt: Number(round.ends_at) || null,
    serverTime: now(),
  };
}

const isAdmin = (req, env) =>
  Boolean(env.ADMIN_KEY) && req.headers.get('x-admin-key') === env.ADMIN_KEY;

// ---------------------------------------------------------------------------
// Judging — one batched call, so the model ranks entries against each other
// ---------------------------------------------------------------------------

const RUBRIC = `You are judging a prompt-writing competition.

Players were shown ONE image and had five minutes to guess the text prompt that produced it. They never saw the original prompt. Score how close each guess came to recreating that image.

Weight your scoring like this:
- Subject and scene (35) — did they identify what is actually depicted?
- Setting and context (20) — the place, surroundings, situation.
- Art style and medium (20) — photo, painting, render, illustration, print.
- Light, colour and mood (15) — time of day, palette, atmosphere.
- Composition and craft (10) — framing, camera angle, and whether the prompt is written in a way that would actually work.

Rules:
- Score 0-100. Be discriminating: spread scores out, do not cluster everything near 70.
- Reward accuracy over length. A short prompt that nails the subject and style beats a long one full of wrong guesses.
- Penalise prompts that contradict the image.
- Ignore spelling and grammar.`;

/**
 * Workers AI returns text in several shapes depending on the model and how
 * recently Cloudflare updated it: a plain `response` string, an array of
 * content blocks, or an OpenAI-style `choices` array. Pull text out of any
 * of them rather than assuming one.
 */
function extractText(out) {
  if (typeof out === 'string') return out;
  if (!out || typeof out !== 'object') return '';

  const fromBlocks = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      return v.map((b) => (typeof b === 'string' ? b : b?.text || b?.content || '')).join('');
    }
    if (v && typeof v === 'object') return v.text || v.content || v.output_text || '';
    return '';
  };

  const candidates = [
    fromBlocks(out.response),
    fromBlocks(out.result?.response),
    fromBlocks(out.output_text),
    fromBlocks(out.output),
    fromBlocks(out.choices?.[0]?.message?.content),
    fromBlocks(out.choices?.[0]?.text),
    fromBlocks(out.message?.content),
    fromBlocks(out.content),
    fromBlocks(out.text),
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

/** Last chance to give every entry a picture before results go out. */
async function repairImages(env, round) {
  const { results: missing } = await env.DB.prepare(
    'SELECT id, prompt FROM submissions WHERE round_id = ? AND image_b64 IS NULL'
  ).bind(round.id).all();
  for (let i = 0; i < missing.length; i += 6) {
    const batch = missing.slice(i, i + 6);
    const images = await Promise.all(batch.map((m) => renderWithRetry(env, m.prompt, ENTRY_STEPS)));
    const writes = batch
      .map((m, j) => (images[j]
        ? env.DB.prepare('UPDATE submissions SET image_b64 = ? WHERE id = ?').bind(images[j], m.id)
        : null))
      .filter(Boolean);
    if (writes.length) await env.DB.batch(writes);
  }
}

// Entries per scoring call. Small enough that the reply never runs out of room,
// which is what used to make everything past ~40 entries silently score zero.
const JUDGE_CHUNK = 25;

const parseJudgeJson = (raw) => {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
};

async function askJudge(env, system, user, maxTokens) {
  const out = await env.AI.run(env.JUDGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature: 0.2,
  });
  return extractText(out).trim();
}

/** Scores one slice of the field. Every chunk carries the hidden prompt and the
 *  full rubric, and is told to score absolutely rather than rank within itself,
 *  so a generous batch cannot inflate the people who happen to be in it. */
async function scoreChunk(env, round, subs) {
  const entries = subs
    .map((sub, i) => `[${i + 1}] id=${sub.id}\n${String(sub.prompt).slice(0, 700)}`)
    .join('\n\n');

  const user = `The original hidden prompt that generated the image was:
"""
${round.secret_prompt}
"""

Score these ${subs.length} player guesses. They are one part of a larger field, so score each
one on its own merits against the hidden prompt above. Do NOT grade on a curve within this
group and do NOT assume one of them is the best — a group may contain no good answers at all.

${entries}

Reply with ONLY a JSON object, no prose before or after:
{ "scores": [ { "id": "<the id given above>", "score": <0-100>, "notes": "<one sentence on what this prompt got right and what it missed>" } ] }
Include every entry.`;

  const parsed = parseJudgeJson(await askJudge(env, RUBRIC, user, 2000));
  return parsed && Array.isArray(parsed.scores) ? parsed.scores : [];
}

/** Picks the winner from the best of every chunk, seeing them side by side. */
async function pickWinner(env, round, finalists) {
  const lines = finalists
    .map((f, i) => `[${i + 1}] id=${f.id}\nscored ${f.score}\n${String(f.prompt).slice(0, 700)}`)
    .join('\n\n');

  const user = `The original hidden prompt that generated the image was:
"""
${round.secret_prompt}
"""

These are the highest scoring guesses from the whole field, already scored:

${lines}

Reply with ONLY a JSON object, no prose before or after:
{
  "winnerId": "<id of the single best entry>",
  "verdict": "<3 to 5 sentences explaining why the winning prompt beat the rest: what it captured that the others missed, and where the runners-up fell short. Refer to entries by what their prompt says, never by number.>"
}`;

  return parseJudgeJson(await askJudge(env, RUBRIC, user, 800)) || {};
}

async function judgeRound(env, round) {
  // Anyone who never came back is charged up to the moment entries closed.
  await env.DB.prepare(
    'UPDATE players SET away_penalty = away_penalty + ' +
    'MAX(0, ((MIN(?, ?) - away_since) - ?) / ?) * ?, away_since = NULL ' +
    'WHERE round_id = ? AND away_since IS NOT NULL'
  ).bind(
    Number(round.ends_at) || now(), now(),
    AWAY_GRACE, AWAY_STEP, AWAY_STEP_PENALTY, round.id
  ).run();

  const { results: subs } = await env.DB.prepare(
    'SELECT s.id, s.player_name, s.prompt, COALESCE(p.blur_count, 0) AS blur_count, ' +
    'COALESCE(p.away_penalty, 0) AS away_penalty, p.away_since ' +
    'FROM submissions s LEFT JOIN players p ' +
    'ON p.round_id = s.round_id AND p.name_key = s.name_key ' +
    'WHERE s.round_id = ? ORDER BY s.created_at ASC'
  ).bind(round.id).all();

  if (!subs.length) throw new Error('No entries to judge.');

  const byId = new Map(subs.map((sub) => [sub.id, sub]));
  const scored = new Map();

  for (let i = 0; i < subs.length; i += JUDGE_CHUNK) {
    const chunk = subs.slice(i, i + JUDGE_CHUNK);
    let rows = await scoreChunk(env, round, chunk);
    if (!rows.length) rows = await scoreChunk(env, round, chunk);   // one retry per chunk
    for (const row of rows) {
      if (!byId.has(row.id) || scored.has(row.id)) continue;
      scored.set(row.id, {
        id: row.id,
        score: Math.max(0, Math.min(100, Math.round(Number(row.score) || 0))),
        notes: String(row.notes || '').slice(0, 600),
      });
    }
  }

  if (!scored.size) throw new Error('The judge scored none of the entries. Try again.');

  // Penalties are re-read now the judge has finished. The earlier read is up to
  // a minute old by this point, and anything that happened in between would
  // otherwise show on the results page without ever reaching the score.
  const { results: fresh } = await env.DB.prepare(
    'SELECT name_key, blur_count, away_penalty FROM players WHERE round_id = ?'
  ).bind(round.id).all();
  const penalties = new Map(fresh.map((p) => [p.name_key, p]));

  const keyOf = await env.DB.prepare(
    'SELECT id, name_key FROM submissions WHERE round_id = ?'
  ).bind(round.id).all();
  const subKey = new Map(keyOf.results.map((x) => [x.id, x.name_key]));

  // The judge's score, less five points per trip away from the tab and the cost
  // of any long absence, floored at zero. Both numbers are kept so the board can
  // show the arithmetic.
  const finals = new Map();
  for (const sub of subs) {
    const hit = scored.get(sub.id);
    const raw = hit ? hit.score : 0;
    const p = penalties.get(subKey.get(sub.id)) || {};
    const switches = Number(p.blur_count) || 0;
    const idle = Number(p.away_penalty) || 0;
    finals.set(sub.id, {
      id: sub.id,
      raw,
      switches,
      score: Math.max(0, raw - switches * BLUR_PENALTY - idle),
      notes: hit ? hit.notes : 'Not scored by the judge.',
    });
  }

  const statements = subs.map((sub) => {
    const f = finals.get(sub.id);
    return env.DB.prepare(
      'UPDATE submissions SET score = ?, raw_score = ?, notes = ? WHERE id = ?'
    ).bind(f.score, f.raw, f.notes, sub.id);
  });

  // Rank on the penalised score; a tie goes to whoever stayed on the tab, and
  // then to whoever submitted first.
  const ranked = [...finals.values()].sort((a, b) =>
    b.score - a.score || a.switches - b.switches || 0);
  const topScore = ranked[0].score;

  let winnerId = null;
  let verdict = 'No prompt scored above zero this round, so there is no winner. Every entry is listed below with what it produced and where it went wrong.';

  if (topScore > 0) {
    const finalists = ranked.slice(0, 8)
      .filter((r) => r.score > 0)
      .map((r) => ({ ...r, prompt: byId.get(r.id).prompt }));
    const chosen = finalists.length > 1
      ? await pickWinner(env, round, finalists)
      : { winnerId: finalists[0].id, verdict: '' };

    // The model may name any finalist; it must still be one of them.
    winnerId = finalists.some((f) => f.id === chosen.winnerId) ? chosen.winnerId : ranked[0].id;
    verdict = String(chosen.verdict || '').trim().slice(0, 2000)
      || 'This prompt scored highest against the hidden prompt across every part of the rubric.';
  }

  statements.push(
    env.DB.prepare(
      'UPDATE rounds SET status = ?, winner_id = ?, verdict = ?, judged_at = ? WHERE id = ?'
    ).bind('published', winnerId, verdict, now(), round.id)
  );

  await env.DB.batch(statements);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      // Pages must never be served from a stale browser cache: a deploy has to
      // take effect on the next load, not whenever the cache decides.
      const res = await env.ASSETS.fetch(request);
      if ((res.headers.get('content-type') || '').includes('text/html')) {
        const headers = new Headers(res.headers);
        headers.set('cache-control', 'no-store, must-revalidate');
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }

    try {
      // ---- player -------------------------------------------------------
      if (path === '/api/state') {
        const round = await currentRound(env);

        // The page tells us which round it was last showing. If that one was
        // aborted, say so explicitly — it is the only way to tell a deliberate
        // abort apart from the host simply moving on to the next round.
        const from = url.searchParams.get('from');
        let sessionAborted = false;
        if (from && (!round || from !== round.id)) {
          const prev = await env.DB.prepare('SELECT status FROM rounds WHERE id = ?')
            .bind(from).first();
          sessionAborted = Boolean(prev && prev.status === 'aborted');
        }

        if (!round) return json({ round: null, sessionAborted });
        const nameKey = (url.searchParams.get('name') || '').trim().toLowerCase();
        let mine = null;
        let myEndsAt = null;
        let draft = '';
        let mySwitches = 0;
        let myIdlePenalty = 0;
        if (nameKey) {
          mine = await env.DB.prepare(
            'SELECT id, prompt, edits FROM submissions WHERE round_id = ? AND name_key = ?'
          ).bind(round.id, nameKey).first();
          const seat = await env.DB.prepare(
            'SELECT joined_at, draft, blur_count, away_penalty FROM players WHERE round_id = ? AND name_key = ?'
          ).bind(round.id, nameKey).first();
          if (seat) {
            myEndsAt = Number(round.ends_at) || null;
            draft = seat.draft || '';
            mySwitches = Number(seat.blur_count) || 0;
            myIdlePenalty = Number(seat.away_penalty) || 0;
          }
        }
        const count = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM submissions WHERE round_id = ?'
        ).bind(round.id).first();
        const { results: roster } = await env.DB.prepare(
          'SELECT p.player_name AS name, ' +
          'EXISTS (SELECT 1 FROM submissions s WHERE s.round_id = p.round_id AND s.name_key = p.name_key) AS done ' +
          'FROM players p WHERE p.round_id = ? ORDER BY p.joined_at ASC LIMIT 200'
        ).bind(round.id).all();
        return json({
          round: publicRound(round),
          entries: count?.n || 0,
          myEndsAt,
          draft,
          mySwitches,
          myIdlePenalty,
          awayGrace: AWAY_GRACE,
          awayStep: AWAY_STEP,
          lockAt: BLUR_LOCK_ENTRY,
          hideAt: BLUR_HIDE_FOREVER,
          penalty: BLUR_PENALTY,
          sessionAborted,
          players: roster.map((r) => ({ name: r.name, done: Boolean(r.done) })),
          mine: mine ? { id: mine.id, prompt: mine.prompt, edits: Number(mine.edits) || 0 } : null,
        });
      }

      // Starts this player's personal clock. Idempotent: rejoining or reloading
      // keeps the original join time, so nobody can reset their own window.
      if (path === '/api/join' && request.method === 'POST') {
        const { name } = await request.json();
        const cleanName = String(name || '').trim().slice(0, 80);
        if (!cleanName) return fail('Enter your name first.');
        const round = await currentRound(env);
        if (!round) return fail('No round is running.');
        if (round.status !== 'draft' && round.status !== 'live') {
          return json({ ok: true, endsAt: null });
        }
        const nameKey = cleanName.toLowerCase();
        await env.DB.prepare(
          'INSERT OR IGNORE INTO players (round_id, name_key, player_name, joined_at) VALUES (?,?,?,?)'
        ).bind(round.id, nameKey, cleanName, now()).run();
        return json({ ok: true, endsAt: Number(round.ends_at) || null });
      }

      // Keeps a running copy of what the player is typing, so an entry is not
      // lost if their browser never gets to submit it.
      if (path === '/api/draft' && request.method === 'POST') {
        const { name, prompt } = await request.json();
        const nameKey = String(name || '').trim().toLowerCase();
        if (!nameKey) return fail('No name.');
        const round = await currentRound(env);
        if (!round || round.status !== 'live') return json({ ok: true });
        await env.DB.prepare(
          'UPDATE players SET draft = ? WHERE round_id = ? AND name_key = ?'
        ).bind(String(prompt || '').slice(0, 1200), round.id, nameKey).run();
        return json({ ok: true });
      }

      // Counted server-side, so reloading the page cannot clear it.
      if (path === '/api/flag' && request.method === 'POST') {
        const { name } = await request.json();
        const nameKey = String(name || '').trim().toLowerCase();
        if (!nameKey) return fail('No name.');
        const round = await currentRound(env);
        if (!round || round.status !== 'live') return json({ ok: true });
        await env.DB.prepare(
          'UPDATE players SET blur_count = blur_count + 1, away_since = ? ' +
          'WHERE round_id = ? AND name_key = ?'
        ).bind(now(), round.id, nameKey).run();
        return json({ ok: true });
      }

      // Returning stops it. The cost of the absence is worked out here, from the
      // server's own clock rather than anything the page reports.
      if (path === '/api/back' && request.method === 'POST') {
        const { name } = await request.json();
        const nameKey = String(name || '').trim().toLowerCase();
        if (!nameKey) return fail('No name.');
        const round = await currentRound(env);
        if (!round || round.status !== 'live') return json({ ok: true, seconds: 0, cost: 0 });
        const seat = await env.DB.prepare(
          'SELECT away_since FROM players WHERE round_id = ? AND name_key = ?'
        ).bind(round.id, nameKey).first();
        if (!seat || !seat.away_since) return json({ ok: true, seconds: 0, cost: 0 });

        const seconds = Math.max(0, now() - Number(seat.away_since));
        const cost = awayCost(seconds);
        await env.DB.prepare(
          'UPDATE players SET away_since = NULL, away_penalty = away_penalty + ? ' +
          'WHERE round_id = ? AND name_key = ?'
        ).bind(cost, round.id, nameKey).run();
        return json({ ok: true, seconds, cost });
      }

      if (path === '/api/image') {
        const kind = url.searchParams.get('kind');
        const key = url.searchParams.get('id');

        if (kind === 'target') {
          const round = await currentRound(env);
          const nameKey = (url.searchParams.get('name') || '').trim().toLowerCase();
          const open = round && round.id === key && round.status === 'live';
          if (open && nameKey) {
            const seat = await env.DB.prepare(
              'SELECT joined_at FROM players WHERE round_id = ? AND name_key = ?'
            ).bind(round.id, nameKey).first();
            if (!seat) return fail('You have not joined this round.', 403);
            if (now() >= Number(round.ends_at) + GRACE) return fail('Time is up.', 403);
          } else if (!(round && round.id === key && round.status === 'published')) {
            // Hosts pass the admin key; everyone else needs a running clock.
            if (!isAdmin(request, env)) return fail('Not available.', 403);
          }
        }

        const row = kind === 'target'
          ? await env.DB.prepare('SELECT image_b64 AS b FROM rounds WHERE id = ?').bind(key).first()
          : await env.DB.prepare('SELECT image_b64 AS b FROM submissions WHERE id = ?').bind(key).first();
        if (!row || !row.b) return fail('No image there.', 404);
        return json({ b64: row.b });
      }

      if (path === '/api/submit' && request.method === 'POST') {
        const { name, prompt, auto } = await request.json();
        const cleanName = String(name || '').trim().slice(0, 80);
        const cleanPrompt = String(prompt || '').trim().slice(0, 1200);
        if (!cleanName) return fail('Enter your name first.');
        if (cleanPrompt.length < 3) return fail('Write a prompt before submitting.');

        const round = await currentRound(env);
        if (!round) return fail('No round is running.');
        if (round.status !== 'live') return fail('This round is not accepting entries.');

        const nameKey = cleanName.toLowerCase();
        const seat = await env.DB.prepare(
          'SELECT joined_at, blur_count FROM players WHERE round_id = ? AND name_key = ?'
        ).bind(round.id, nameKey).first();
        if (!seat) return fail('You have not joined this round. Reload the page.');
        if ((Number(seat.blur_count) || 0) >= BLUR_LOCK_ENTRY) {
          return fail(`You left the tab ${BLUR_LOCK_ENTRY} times, so entries are closed for you.`);
        }
        const limit = Number(round.ends_at) + (auto ? GRACE : 0);
        if (now() >= limit) return fail('Time is up.');
        const existing = await env.DB.prepare(
          'SELECT id FROM submissions WHERE round_id = ? AND name_key = ?'
        ).bind(round.id, nameKey).first();
        if (existing) return fail('You have already entered this round.');

        // Render what the player's prompt actually produces, so the results
        // wall can show guess against target side by side.
        // No picture yet — everything is rendered once the round closes.
        const subId = id();
        try {
          await env.DB.prepare(
            'INSERT INTO submissions (id, round_id, player_name, name_key, prompt, image_b64, created_at) VALUES (?,?,?,?,?,?,?)'
          ).bind(subId, round.id, cleanName, nameKey, cleanPrompt, null, now()).run();
        } catch {
          return fail('You have already entered this round.');
        }
        return json({ ok: true, id: subId });
      }

      // Revising replaces the stored prompt AND re-renders the image, so the
      // results wall always shows what the final prompt actually produced.
      if (path === '/api/update' && request.method === 'POST') {
        const { name, prompt } = await request.json();
        const cleanName = String(name || '').trim().slice(0, 80);
        const cleanPrompt = String(prompt || '').trim().slice(0, 1200);
        if (!cleanName) return fail('Enter your name first.');
        if (cleanPrompt.length < 3) return fail('Write a prompt before saving.');

        const round = await currentRound(env);
        if (!round) return fail('No round is running.');
        if (round.status !== 'live') return fail('This round is closed.');

        const nameKey = cleanName.toLowerCase();
        const seat = await env.DB.prepare(
          'SELECT joined_at, blur_count FROM players WHERE round_id = ? AND name_key = ?'
        ).bind(round.id, nameKey).first();
        if (!seat) return fail('You have not joined this round. Reload the page.');
        if (now() >= Number(round.ends_at)) {
          return fail('Time is up — this entry is locked.');
        }
        if ((Number(seat.blur_count) || 0) >= BLUR_LOCK_ENTRY) {
          return fail(`Your entry was locked after ${BLUR_LOCK_ENTRY} tab switches.`);
        }

        const existing = await env.DB.prepare(
          'SELECT id, prompt, edits FROM submissions WHERE round_id = ? AND name_key = ?'
        ).bind(round.id, nameKey).first();
        if (!existing) return fail('You have not entered yet.');

        // An unchanged save is not an edit, so it costs nothing.
        if (existing.prompt === cleanPrompt) {
          return json({ ok: true, unchanged: true });
        }

        const used = Number(existing.edits) || 0;
        await env.DB.prepare(
          'UPDATE submissions SET prompt = ?, score = NULL, notes = NULL, edits = ? WHERE id = ?'
        ).bind(cleanPrompt, used + 1, existing.id).run();
        return json({ ok: true, edits: used + 1 });
      }

      if (path === '/api/results') {
        const round = await currentRound(env);
        if (!round) return json({ round: null });
        if (round.status !== 'published') {
          return json({ round: publicRound(round), published: false });
        }
        const { results } = await env.DB.prepare(
          'SELECT s.id, s.player_name, s.prompt, s.score, s.raw_score, s.notes, ' +
          's.image_b64 IS NOT NULL AS has_image, COALESCE(p.blur_count, 0) AS blur_count, ' +
          'COALESCE(p.away_penalty, 0) AS away_penalty ' +
          'FROM submissions s LEFT JOIN players p ' +
          'ON p.round_id = s.round_id AND p.name_key = s.name_key ' +
          'WHERE s.round_id = ? ORDER BY s.score DESC, blur_count ASC, s.created_at ASC'
        ).bind(round.id).all();
        return json({
          round: publicRound(round),
          published: true,
          secretPrompt: round.secret_prompt,
          verdict: round.verdict,
          winnerId: round.winner_id,
          blurPenalty: BLUR_PENALTY,
          board: results.map((r, i) => ({
            rank: i + 1,
            id: r.id,
            name: r.player_name,
            prompt: r.prompt,
            score: r.score,
            rawScore: r.raw_score === null ? r.score : r.raw_score,
            penalty: Math.max(0, (Number(r.raw_score) || 0) - (Number(r.score) || 0)),
            switchPenalty: (Number(r.blur_count) || 0) * BLUR_PENALTY,
            idlePenalty: Number(r.away_penalty) || 0,
            notes: r.notes,
            hasImage: Boolean(r.has_image),
            blurCount: Number(r.blur_count) || 0,
          })),
        });
      }

      // ---- admin --------------------------------------------------------
      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(request, env)) return fail('Wrong admin key.', 401);

        if (path === '/api/admin/state') {
          const round = await currentRound(env);
          if (!round) return json({ round: null });
          const count = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM submissions WHERE round_id = ?'
          ).bind(round.id).first();
          const joined = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM players WHERE round_id = ?'
          ).bind(round.id).first();
          const stillGoing = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM players p WHERE p.round_id = ? ' +
            'AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.round_id = p.round_id AND s.name_key = p.name_key)'
          ).bind(round.id).first();
          const flagged = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM players WHERE round_id = ? AND blur_count > 0'
          ).bind(round.id).first();
          const imgs = await env.DB.prepare(
            'SELECT COUNT(*) AS total, SUM(CASE WHEN image_b64 IS NULL THEN 1 ELSE 0 END) AS left_ ' +
            'FROM submissions WHERE round_id = ?'
          ).bind(round.id).first();
          return json({
            round: { ...publicRound(round), secretPrompt: round.secret_prompt },
            entries: count?.n || 0,
            flagged: flagged?.n || 0,
            rendered: (Number(imgs?.total) || 0) - (Number(imgs?.left_) || 0),
            pending: Number(imgs?.left_) || 0,
            joined: joined?.n || 0,
            stillGoing: stillGoing?.n || 0,
            roundSeconds: roundSeconds(env),
          });
        }

        // Abandons whatever is running and replaces it with a fresh image, in
        // one step, so players never see a half-torn-down round.
        if (path === '/api/admin/session' && request.method === 'POST') {
          // Whatever it was — waiting, running, or showing results — it is over,
          // and everyone still looking at it needs to be told.
          const current = await currentRound(env);
          if (current) {
            await env.DB.prepare('UPDATE rounds SET status = ? WHERE id = ?')
              .bind('aborted', current.id).run();
          }
          const secret = composePrompt();
          const image = await renderImage(env, secret, TARGET_STEPS);
          const roundId = id();
          await env.DB.prepare(
            'INSERT INTO rounds (id, secret_prompt, image_b64, status, created_at) VALUES (?,?,?,?,?)'
          ).bind(roundId, secret, image, 'draft', now()).run();
          return json({ ok: true, roundId, aborted: Boolean(current) });
        }

        // Summing image sizes scans every row, so the console asks for this
        // once when it opens rather than on every poll.
        // Every round ever run, newest first, optionally filtered by status.
        if (path === '/api/admin/rounds') {
          const status = url.searchParams.get('status') || 'all';
          const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
          const per = 10;

          const where = status === 'all' ? '' : 'WHERE r.status = ?';
          const args = status === 'all' ? [] : [status];

          const total = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM rounds r ${where}`
          ).bind(...args).first();

          const { results } = await env.DB.prepare(
            'SELECT r.id, r.status, r.created_at, r.started_at, r.judged_at, r.winner_id, ' +
            '(SELECT COUNT(*) FROM submissions s WHERE s.round_id = r.id) AS entries, ' +
            '(SELECT s.player_name FROM submissions s WHERE s.id = r.winner_id) AS winner ' +
            `FROM rounds r ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
          ).bind(...args, per, page * per).all();

          return json({
            page, per,
            total: Number(total?.n) || 0,
            pages: Math.ceil((Number(total?.n) || 0) / per),
            rounds: results.map((r) => ({
              id: r.id,
              status: r.status,
              createdAt: Number(r.created_at) || null,
              startedAt: Number(r.started_at) || null,
              judgedAt: Number(r.judged_at) || null,
              entries: Number(r.entries) || 0,
              winner: r.winner || null,
            })),
          });
        }

        // One past round in full, whatever its status.
        if (path === '/api/admin/round') {
          const id_ = url.searchParams.get('id');
          const r = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?').bind(id_).first();
          if (!r) return fail('No such round.', 404);
          const { results } = await env.DB.prepare(
            'SELECT s.id, s.player_name, s.prompt, s.score, s.raw_score, s.notes, ' +
            's.created_at, s.edits, ' +
            's.image_b64 IS NOT NULL AS has_image, COALESCE(p.blur_count, 0) AS blur_count, ' +
            'COALESCE(p.away_penalty, 0) AS away_penalty, COALESCE(p.joined_at, 0) AS joined_at ' +
            'FROM submissions s LEFT JOIN players p ' +
            'ON p.round_id = s.round_id AND p.name_key = s.name_key ' +
            'WHERE s.round_id = ? ORDER BY s.score DESC, blur_count ASC, s.created_at ASC'
          ).bind(id_).all();

          return json({
            round: {
              id: r.id, status: r.status,
              createdAt: Number(r.created_at) || null,
              judgedAt: Number(r.judged_at) || null,
              secretPrompt: r.secret_prompt,
              verdict: r.verdict,
              winnerId: r.winner_id,
            },
            blurPenalty: BLUR_PENALTY,
            board: results.map((x, i) => ({
              rank: i + 1, id: x.id, name: x.player_name, prompt: x.prompt,
              score: x.score, rawScore: x.raw_score === null ? x.score : x.raw_score,
              switchPenalty: (Number(x.blur_count) || 0) * BLUR_PENALTY,
              idlePenalty: Number(x.away_penalty) || 0,
              blurCount: Number(x.blur_count) || 0,
              submittedAt: Number(x.created_at) || null,
              joinedAt: Number(x.joined_at) || null,
              edits: Number(x.edits) || 0,
              notes: x.notes, hasImage: Boolean(x.has_image),
            })),
          });
        }

        if (path === '/api/admin/storage') {
          const r = await env.DB.prepare(
            'SELECT (SELECT COUNT(*) FROM rounds) AS rounds, ' +
            '(SELECT COUNT(*) FROM submissions) AS entries, ' +
            '(SELECT COALESCE(SUM(LENGTH(image_b64)),0) FROM submissions) AS entry_bytes, ' +
            '(SELECT COALESCE(SUM(LENGTH(image_b64)),0) FROM rounds) AS target_bytes, ' +
            "(SELECT COUNT(*) FROM rounds WHERE status IN ('aborted','draft')) AS abandoned"
          ).first();

          const bytes = (Number(r?.entry_bytes) || 0) + (Number(r?.target_bytes) || 0);
          const LIMIT = 5 * 1024 * 1024 * 1024;          // D1 free plan
          const rounds = Number(r?.rounds) || 0;
          const abandoned = Number(r?.abandoned) || 0;

          // Well before the limit matters, nudge on round count — a tidy-up is
          // cheap and the point is never to arrive at the ceiling by surprise.
          let level = 'ok';
          if (bytes > LIMIT * 0.5 || rounds > 40) level = 'warn';
          else if (bytes > LIMIT * 0.1 || rounds > 10 || abandoned > 3) level = 'tidy';

          return json({
            rounds, abandoned,
            entries: Number(r?.entries) || 0,
            bytes,
            mb: Math.round(bytes / 1048576),
            percent: Math.round((bytes / LIMIT) * 1000) / 10,
            level,
          });
        }

        if (path === '/api/admin/generate' && request.method === 'POST') {
          const secret = composePrompt();
          const image = await renderImage(env, secret, TARGET_STEPS);
          const roundId = id();
          await env.DB.prepare(
            'INSERT INTO rounds (id, secret_prompt, image_b64, status, created_at) VALUES (?,?,?,?,?)'
          ).bind(roundId, secret, image, 'draft', now()).run();
          return json({ ok: true, roundId, secretPrompt: secret });
        }

        if (path === '/api/admin/start' && request.method === 'POST') {
          const round = await currentRound(env);
          if (!round) return fail('Generate a round first.');
          if (round.status !== 'draft') return fail('That round has already been started.');
          const t = now();
          await env.DB.prepare(
            'UPDATE rounds SET status = ?, started_at = ?, ends_at = ? WHERE id = ?'
          ).bind('live', t, t + roundSeconds(env), round.id).run();
          return json({ ok: true, startedAt: t, endsAt: t + roundSeconds(env) });
        }

        if (path === '/api/admin/close' && request.method === 'POST') {
          const round = await currentRound(env);
          if (!round) return fail('No round.');
          await sweepDrafts(env, round);
          await env.DB.prepare('UPDATE rounds SET status = ?, ends_at = ? WHERE id = ?')
            .bind('closed', now(), round.id).run();
          return json({ ok: true });
        }

        // Renders a slice of the round's entries. The console calls this
        // repeatedly until nothing is pending, which keeps every request well
        // inside Cloudflare's subrequest ceiling.
        if (path === '/api/admin/render' && request.method === 'POST') {
          const round = await currentRound(env);
          if (!round) return fail('No round.');
          if (round.status === 'live') return fail('Close the round first.');

          const { results: pending } = await env.DB.prepare(
            'SELECT id, prompt FROM submissions WHERE round_id = ? AND image_b64 IS NULL ' +
            'ORDER BY created_at ASC LIMIT ?'
          ).bind(round.id, RENDER_BATCH).all();

          let made = 0;
          if (pending.length) {
            const images = await Promise.all(
              pending.map((e) => renderWithRetry(env, e.prompt, ENTRY_STEPS))
            );
            const writes = pending
              .map((e, i) => (images[i]
                ? env.DB.prepare('UPDATE submissions SET image_b64 = ? WHERE id = ?').bind(images[i], e.id)
                : null))
              .filter(Boolean);
            made = writes.length;
            if (writes.length) await env.DB.batch(writes);
          }

          const totals = await env.DB.prepare(
            'SELECT COUNT(*) AS total, SUM(CASE WHEN image_b64 IS NULL THEN 1 ELSE 0 END) AS left_ ' +
            'FROM submissions WHERE round_id = ?'
          ).bind(round.id).first();

          return json({
            ok: true,
            made,
            attempted: pending.length,
            total: Number(totals?.total) || 0,
            remaining: Number(totals?.left_) || 0,
            // Nothing rendered from a non-empty batch means every prompt in it
            // was refused; stop rather than loop on the same rows for ever.
            stuck: pending.length > 0 && made === 0,
          });
        }

        if (path === '/api/admin/judge' && request.method === 'POST') {
          const round = await currentRound(env);
          if (!round) return fail('No round.');
          if (round.status === 'live') return fail('Close the round before scoring.');
          await judgeRound(env, round);
          return json({ ok: true });
        }

        if (path === '/api/admin/discard' && request.method === 'POST') {
          const round = await currentRound(env);
          if (!round) return fail('No round.');
          if (round.status !== 'draft') return fail('Only an unstarted round can be discarded.');
          await env.DB.batch([
            env.DB.prepare('DELETE FROM players WHERE round_id = ?').bind(round.id),
            env.DB.prepare('DELETE FROM rounds WHERE id = ?').bind(round.id),
          ]);
          return json({ ok: true });
        }
      }

      return fail('Unknown endpoint.', 404);
    } catch (err) {
      return fail(err.message || 'Something went wrong.', 500);
    }
  },
};
