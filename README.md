# Greatest of them all

Anyone can create a tournament (upload images + names), and anyone can vote. Votes update Elo ratings
in a SQLite database and feed a live leaderboard. No accounts needed.

## Run locally
    npm install
    npm start          # http://localhost:3000

Requires Node 22.13+ (uses the built-in `node:sqlite`, so nothing needs compiling). Data is stored in `data.db` (override with `DB_PATH`).

## Deploy (example: Render)
1. Push this folder to a GitHub repo.
2. New Web Service -> build `npm install`, start `npm start`.
3. Add a Persistent Disk (e.g. mounted at `/data`) and set env `DB_PATH=/data/data.db`,
   otherwise the database is wiped on each deploy. (Fly.io volumes or any VPS work the same way.)
4. Optional: set `ADMIN_KEY` to a secret so you can remove any tournament:
       curl -X DELETE https://YOURSITE/api/tournaments/TOURNAMENT_ID -H "x-admin-key: YOUR_SECRET"

## How it works
- Elo: everyone starts at 1000. Expected score = 1/(1+10^((Rb-Ra)/400)). K=40 for an entry's first 10 games, then 24.
  Each vote is applied atomically in one SQLite transaction (no race conditions).
- Pairing: favours the least-played entries, with opponents weighted toward similar ratings.
- Creators get a private delete token (kept in their browser's localStorage) so only they can delete their tournament.
- Basic abuse limits: per-IP rate limits, max 40 entries, JPEG-only images under 400 KB each.

## Files
- `server.js` API + SQLite + Elo
- `public/` front-end (index.html, app.js, style.css), 2014-style look
