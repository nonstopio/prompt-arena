# Prompt Arena

A live prompt-writing competition. You click **Generate round**, the server invents a
random hidden prompt, renders it as an image, and that image becomes the question.
Everyone in the room gets the same one, has five minutes to write the prompt they think
produced it, and every submitted prompt is rendered too — so the results wall shows each
person's guess next to what it actually produced. A language model scores all entries
against the hidden prompt and writes the explanation for why the winner won.

Runs entirely inside Cloudflare's free daily allowance. No credit card.

---

## Part 1 — Set up Cloudflare (one time, ~5 minutes)

### 1. Create the account
1. Go to **https://dash.cloudflare.com/sign-up**
2. Sign up with email or GitHub, then verify the email they send you.
3. Stay on the **Workers Free** plan. Do not add a card.

### 2. Install Node.js (skip if you already have it)
Download the LTS build from **https://nodejs.org** and install it.
Check it worked — open Terminal / Command Prompt and run:
```
node -v
```
You should see something like `v22.x.x`.

### 3. Log Wrangler into your account
In the project folder (the one containing `wrangler.toml`), run:
```
npx wrangler login
```
A browser tab opens. Click **Allow**. Come back to the terminal when it says success.

---

## Part 2 — Deploy the app (~5 minutes)

### 4. Create the database
```
npx wrangler d1 create prompt-arena
```
The output ends with a block like this:
```
[[d1_databases]]
binding = "DB"
database_name = "prompt-arena"
database_id = "a1b2c3d4-...."
```
Copy the `database_id` value. Open **`wrangler.toml`** in any text editor, find the line:
```
database_id = "PASTE_YOUR_DATABASE_ID_HERE"
```
and replace the placeholder with your id. Save the file.

### 5. Create the tables
```
npx wrangler d1 execute prompt-arena --remote --file=./schema.sql
```
Type `y` if it asks for confirmation.

### 6. Set your host password
```
npx wrangler secret put ADMIN_KEY
```
It will ask you to type a value. Type any password you like (this is what unlocks the
host console) and press Enter. Nothing appears as you type — that's normal.

### 7. Deploy
```
npx wrangler deploy
```
The last line prints your live URL, something like:
```
https://prompt-arena.<your-subdomain>.workers.dev
```
**That is the link you share.** Open it to check it loads.

---

## Part 3 — Running the competition

| Page | Who | URL |
|---|---|---|
| Player | Everyone | `https://your-url.workers.dev/` |
| Host console | You only | `https://your-url.workers.dev/admin.html` |

**Before the session**
1. Open the host console and enter your `ADMIN_KEY`. It opens on a neutral screen telling
   you what state things are in — it never drops you straight into a published result.
   **Start a new session** in the blue bar at the top works from anywhere, at any time. It
   asks for your admin key again before doing anything, because it abandons whatever is
   running. Anyone mid-round is told the session was aborted by the admin and gets a button
   to join the new one; nothing from the abandoned round is scored.
2. Click **Generate round**. Wait a few seconds for the image.
3. Look at it. If it's a mess, click **Generate a different image** — you'll get a fresh
   random one. The hidden prompt is shown to you on this screen only, so don't screen-share
   the host console.
4. Share the player link. Everyone types their full name and lands on a waiting screen.

**During**
5. Wait until the room has entered their names. Players see each other arrive in a lobby
   list, and your console shows the joined count. Nobody's clock runs while they wait.
6. Click **Start the 5-minute round**. The same countdown begins for everyone at once,
   held on the server, so reloading a page does not change anyone's deadline. Someone who
   joins late gets whatever time is left, not a fresh five.
7. Entries close by themselves at zero. There is a **Close entries now** button if the room
   finishes early.

**After**
8. Once entries close, the console shows **Preparing the results** with a progress bar and
   turns every prompt into an image, ten at a time. Around a second per entry, so roughly
   90 seconds for 100 people. Leave the page open; a **Retry** button picks up where it
   left off if the connection drops.
9. When it reaches the end, click **Score and publish results**. Entries are read in
   batches of 25 and the best are then compared to pick the winner, so allow up to a minute
   for a full room. The console shows a scoring screen while it runs.
10. Every player's screen switches to the leaderboard by itself — the original image at the
   top to compare against, then ranks, scores, every prompt, the image each prompt
   produced, the hidden prompt revealed, and the written explanation of why the winner won.
11. For the next round, click **Generate the next round** and repeat from step 3.

---

## Things worth knowing

**A round can end with no winner.** If the best entry scores zero, nobody is crowned. The
full board still publishes with every prompt, every rendered image and the judge's notes,
under a "No winner this round" heading.

**Rounds are independent.** Each round is scored on its own and the leaderboard is per
round, as agreed. Older rounds stay in the database if you ever want to total them up.

**One entry per name.** Enforced on the name, case-insensitively. Since names aren't
verified, someone could enter twice under a different spelling. For a room-based session
that's usually fine; worth saying out loud at the start.

**Anyone with the link can play.** Dropping the email check also dropped the
`nonstopio.com` gate — there's nothing left to check a person against. Treat the URL as
the access control and share it only in your internal channel. If you later want the
domain restriction back, email is the only practical way to do it.

**Free tier headroom.** Cloudflare gives 10,000 neurons/day, resetting at 00:00 UTC
(5:30 AM IST). A 100-person round costs about **7,900** and the figure is fixed, because
images are made once after the round however much anyone edits:

| | Neurons |
|---|---|
| Question image, full quality | 58 |
| 100 entry images, half the diffusion steps | 3,840 |
| Scoring, in batches of 25, plus the winner pass | ~4,000 |
| **Total** | **~7,900** |

That leaves roughly 2,100 spare — about 55 target regenerations or failed-render retries.

**Revising an entry.** Unlimited, while the clock is running. Nothing is rendered during
the round, so editing costs nothing — only the final wording is turned into an image. Each save re-renders their image, so the results wall always
shows what the final prompt produced. Once their five minutes end, the entry locks.

**About protecting the image.** A browser cannot black out screenshots. That behaviour in
banking apps comes from native OS flags — FLAG_SECURE on Android, protected-window APIs on
iOS and macOS — which only an installed app can set. No website can do it, in any browser.

What the app does instead:
- Painted into a canvas, so save, drag and long-press give nothing.
- Right-click and text selection are off over the image.
- "NonStop io Technologies" is watermarked across it. Players are told twice — on the join
  screen and above the image while writing — to ignore it and not describe it in a prompt.
- It blanks whenever the tab or window loses focus, closing the alt-tab-to-another-AI route.
- Every time a player switches away from the tab during a live round, it is counted on the
  server — reloading does not reset it — and shown as a badge beside their name on the
  results screen, plus a running total on the host console. Notifications and second
  monitors trigger it too, so treat it as a signal rather than proof.
- The server refuses to serve it to anyone without a running clock, so it cannot be pulled
  before the round opens or after it closes.

The only way to keep the image off participants' devices entirely is to show it on a
projector and leave their screens with just the clock and the prompt box.

**Every entry gets a picture.** Images are made after the round closes, not as people
submit — so a round costs exactly one render per person however much anyone edits. Each
render is retried, then retried with a neutrally reworded version. If a prompt is refused
every time, the progress screen says so and you can publish anyway; that entry appears
without a picture.

**Changing the round length.** In `wrangler.toml`, edit `ROUND_SECONDS = "300"` and run
`npx wrangler deploy` again. This is the per-player window, not the length of the round.

**Nothing is lost at the buzzer.** Whatever is in a player's box when the clock hits zero
is submitted for them automatically. Their text is also saved to the server as they type,
so if their tab is closed or their connection drops, closing the round sweeps that saved
draft into a real entry and renders it. A box left completely empty submits nothing.

**Cleaning up the database.** The host console's opening screen reports how much is stored
and tells you when a tidy-up is due, long before it matters — amber once it is worth doing,
red if it has been left. It shows the one command that does most of the work.
`MAINTENANCE.md` has the full set, a suggested routine, and how to back up results first.

**Seeing past data.**
```
npx wrangler d1 execute prompt-arena --remote --command="SELECT player_name, score FROM submissions ORDER BY score DESC"
```
