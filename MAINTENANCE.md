# Database maintenance

Nothing in the app deletes anything, so images accumulate round after round. At roughly
200 KB per image and ~100 entries a round, that is about **20 MB per round** against D1's
5 GB free limit — room for around 250 rounds, or roughly five years at one a week.

Not urgent, but worth a routine.

Run every command below from the project folder (the one containing `wrangler.toml`).

> **Never run `schema.sql` again.** It begins with `DROP TABLE` and wipes everything.
> Use the `migrate-*.sql` files only.
>
> **Never run any of this mid-session.** Deleting from `rounds` while a round is live
> breaks it for everyone.

---

## 1. Check where you stand

```
npx wrangler d1 execute prompt-arena --remote --command="SELECT (SELECT COUNT(*) FROM rounds) AS rounds, (SELECT COUNT(*) FROM submissions) AS entries, (SELECT SUM(LENGTH(image_b64))/1048576 FROM submissions) AS entry_image_mb, (SELECT SUM(LENGTH(image_b64))/1048576 FROM rounds) AS target_image_mb"
```

The two `_mb` figures are where essentially all the space goes. Everything else — prompts,
names, scores — is a few KB per round.

Per-round breakdown, so you can see which rounds are heaviest:

```
npx wrangler d1 execute prompt-arena --remote --command="SELECT r.id, datetime(r.created_at,'unixepoch') AS created, r.status, COUNT(s.id) AS entries, SUM(LENGTH(s.image_b64))/1048576 AS mb FROM rounds r LEFT JOIN submissions s ON s.round_id = r.id GROUP BY r.id ORDER BY r.created_at DESC"
```

---

## 2. Back up results before deleting anything

```
npx wrangler d1 execute prompt-arena --remote --json --command="SELECT datetime(r.created_at,'unixepoch') AS round_date, r.secret_prompt, s.player_name, s.score, s.prompt, s.notes FROM submissions s JOIN rounds r ON r.id = s.round_id ORDER BY r.created_at DESC, s.score DESC" > results-backup.json
```

Leaderboards only, no images, so the file stays small.

---

## 3. Recommended: drop old images, keep the history

This is the cleanup to run regularly. It clears the pictures from everything except the
three most recent rounds, while keeping every prompt, name and score. Old results pages
still load — the thumbnails are simply empty.

**Entry images:**

```
npx wrangler d1 execute prompt-arena --remote --command="UPDATE submissions SET image_b64 = NULL WHERE round_id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 3)"
```

**Target images:**

```
npx wrangler d1 execute prompt-arena --remote --command="UPDATE rounds SET image_b64 = '' WHERE id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 3)"
```

Change `LIMIT 3` to keep more or fewer rounds intact.

---

## 4. Remove abandoned rounds

Rounds that were aborted, or generated and never started, are pure waste — an image nobody
ever saw. The `LIMIT 1` exclusion protects a round you may be setting up right now.

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM players WHERE round_id IN (SELECT id FROM rounds WHERE status IN ('aborted','draft') AND id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 1))"
```

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM submissions WHERE round_id IN (SELECT id FROM rounds WHERE status IN ('aborted','draft') AND id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 1))"
```

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM rounds WHERE status IN ('aborted','draft') AND id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 1)"
```

---

## 5. Delete old rounds entirely

Only if you do not want the history at all. Keeps the last three rounds.

**Order matters** — delete `submissions` and `players` *before* `rounds`, or the subquery
has nothing left to match against and the child rows are orphaned forever.

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM submissions WHERE round_id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 3)"
```

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM players WHERE round_id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 3)"
```

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM rounds WHERE id NOT IN (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 3)"
```

---

## 6. Start completely fresh

Wipes all rounds, entries and players. The tables and their structure survive, so there is
no need to re-run any migration afterwards.

```
npx wrangler d1 execute prompt-arena --remote --command="DELETE FROM submissions; DELETE FROM players; DELETE FROM rounds"
```

---

## 7. Check the reclaimed size

There is no `VACUUM` to run — D1 blocks it, along with other SQLite maintenance statements,
through the query API. Space is reclaimed for you; you do not have to ask.

Two things to know about when it happens:

- D1 keeps 30 days of point-in-time history (Time Travel), so deleted rows are retained for
  that window before the space is genuinely released. A large delete will not shrink the
  reported size straight away.
- The `SUM(LENGTH(...))` figures in section 1 drop immediately, because they measure live
  rows rather than the file. Use them to confirm a cleanup worked.

To see the real database size and state:

```
npx wrangler d1 info prompt-arena
```

## Suggested routine

| When | What |
|---|---|
| After each session | Section 4 — clear abandoned rounds |
| Every month or so | Section 2 to back up, then section 3 to drop old images |
| Once or twice a year | Section 7 to check the size has come down |

---

## Useful one-off queries

**Top scores across every round ever run:**

```
npx wrangler d1 execute prompt-arena --remote --command="SELECT player_name, MAX(score) AS best, COUNT(*) AS rounds_played FROM submissions GROUP BY name_key ORDER BY best DESC LIMIT 20"
```

**Who left the tab most in the last round:**

```
npx wrangler d1 execute prompt-arena --remote --command="SELECT player_name, blur_count FROM players WHERE round_id = (SELECT id FROM rounds ORDER BY created_at DESC LIMIT 1) AND blur_count > 0 ORDER BY blur_count DESC"
```

**Entries that never got a picture:**

```
npx wrangler d1 execute prompt-arena --remote --command="SELECT r.id AS round, COUNT(*) AS missing FROM submissions s JOIN rounds r ON r.id = s.round_id WHERE s.image_b64 IS NULL GROUP BY r.id"
```
