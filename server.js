const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const tx = fn => (...a) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
db.exec(`
CREATE TABLE IF NOT EXISTS tournaments(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, delete_token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, tid TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, img BLOB NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1000, w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS items_tid ON items(tid);
CREATE TABLE IF NOT EXISTS votes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tid TEXT NOT NULL, winner TEXT NOT NULL, loser TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS votes_tid ON votes(tid);
`);
if (!db.prepare('PRAGMA table_info(tournaments)').all().some(c => c.name === 'cover')) db.exec('ALTER TABLE tournaments ADD COLUMN cover BLOB');

/* ---------- Elo: start 1000, K=40 for an item's first 10 games, then 24 ---------- */
const kFor = i => (i.w + i.l) < 10 ? 40 : 24;
const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
function elo(win, lose) {
  const e = expected(win.elo, lose.elo);
  return [Math.round(kFor(win) * (1 - e)), Math.round(-kFor(lose) * (1 - e))];
}

/* ---------- Pairing: favour least-played item, opponent weighted by rating closeness ---------- */
function pickPair(items, exclude) {
  if (items.length < 2) return null;
  const min = Math.min(...items.map(i => i.w + i.l));
  const pool = items.filter(i => i.w + i.l <= min + 1);
  const a = pool[Math.floor(Math.random() * pool.length)];
  let others = items.filter(i => i !== a && [i.id, a.id].sort().join() !== exclude);
  if (!others.length) others = items.filter(i => i !== a);
  const ws = others.map(o => 1 / (1 + Math.abs(o.elo - a.elo) / 100));
  let r = Math.random() * ws.reduce((x, y) => x + y, 0), b = others[0];
  for (let i = 0; i < others.length; i++) { r -= ws[i]; if (r <= 0) { b = others[i]; break; } }
  return Math.random() < 0.5 ? [a, b] : [b, a];
}

/* ---------- Tiny per-IP rate limiter ---------- */
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const k = req.ip + req.route.path, now = Date.now();
  let h = hits.get(k);
  if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
  h.n++; hits.set(k, h);
  if (h.n > max) return res.status(429).json({ error: 'Slow down a little and try again.' });
  next();
};
setInterval(() => { const n = Date.now(); for (const [k, h] of hits) if (h.reset < n) hits.delete(k); }, 60000).unref();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uid = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);


function parseJpeg(img) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(img || '');
  const buf = m && Buffer.from(m[1], 'base64');
  if (!buf || buf.length > 400e3 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Each image must be a valid JPEG under 400 KB.');
  return buf;
}

function parseNew(list) {
  return list.map(it => {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(it.img || '');
    const buf = m && Buffer.from(m[1], 'base64');
    if (!buf || buf.length > 400e3 || buf[0] !== 0xff || buf[1] !== 0xd8)
      throw new Error('Each entry needs a valid JPEG image under 400 KB.');
    return { id: uid(), name: clean(it.name, 80) || 'Untitled', img: buf };
  });
}

app.get('/api/tournaments', (req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.name, t.created_at AS createdAt, (t.cover IS NOT NULL) AS hasCover,
      (SELECT COUNT(*) FROM items WHERE tid = t.id) AS n,
      (SELECT COUNT(*) FROM votes WHERE tid = t.id) AS votes
    FROM tournaments t ORDER BY t.created_at DESC LIMIT 200`).all());
});

app.post('/api/tournaments', limit(10, 3600e3), (req, res) => {
  const name = clean(req.body.name, 80), list = req.body.items;
  if (!name) return res.status(400).json({ error: 'Give the tournament a name.' });
  if (!Array.isArray(list) || list.length < 2 || list.length > 40)
    return res.status(400).json({ error: 'A tournament needs 2 to 40 entries.' });
  let rows, cover = null;
  try { rows = parseNew(list); if (req.body.cover) cover = parseJpeg(req.body.cover); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = uid(), token = crypto.randomBytes(16).toString('hex');
  tx(() => {
    db.prepare('INSERT INTO tournaments(id,name,created_at,delete_token,cover) VALUES(?,?,?,?,?)').run(id, name, Date.now(), token, cover);
    const ins = db.prepare('INSERT INTO items(id,tid,name,img) VALUES(?,?,?,?)');
    rows.forEach(r => ins.run(r.id, id, r.name, r.img));
  })();
  res.json({ id, deleteToken: token });
});

app.get('/api/tournaments/:id', (req, res) => {
  const t = db.prepare('SELECT id,name,(cover IS NOT NULL) AS hasCover FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  t.items = db.prepare('SELECT id,name,elo,w,l FROM items WHERE tid=? ORDER BY elo DESC, w DESC').all(t.id);
  t.votes = db.prepare('SELECT COUNT(*) c FROM votes WHERE tid=?').get(t.id).c;
  res.json(t);
});

app.get('/api/tournaments/:id/pair', (req, res) => {
  const t = db.prepare('SELECT id,name FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  const items = db.prepare('SELECT id,name,elo,w,l FROM items WHERE tid=?').all(t.id);
  const pair = pickPair(items, String(req.query.last || ''));
  res.json({ name: t.name, pair: pair && pair.map(i => ({ id: i.id, name: i.name })) });
});

app.post('/api/tournaments/:id/vote', limit(90, 60e3), (req, res) => {
  const { winner, loser } = req.body || {};
  const out = tx(() => {
    const get = db.prepare('SELECT id,name,elo,w,l FROM items WHERE id=? AND tid=?');
    const W = get.get(String(winner), req.params.id), L = get.get(String(loser), req.params.id);
    if (!W || !L || W.id === L.id) return null;
    const [dw, dl] = elo(W, L);
    const upd = db.prepare('UPDATE items SET elo=elo+?, w=w+?, l=l+? WHERE id=?');
    upd.run(dw, 1, 0, W.id); upd.run(dl, 0, 1, L.id);
    db.prepare('INSERT INTO votes(tid,winner,loser,ts) VALUES(?,?,?,?)').run(req.params.id, W.id, L.id, Date.now());
    return { winner: { name: W.name, delta: dw }, loser: { name: L.name, delta: dl } };
  })();
  if (!out) return res.status(400).json({ error: 'Invalid vote.' });
  res.json(out);
});

app.put('/api/tournaments/:id', limit(60, 3600e3), (req, res) => {
  const t = db.prepare('SELECT delete_token FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  const okTok = req.get('x-delete-token') === t.delete_token;
  const okAdmin = ADMIN_KEY && req.get('x-admin-key') === ADMIN_KEY;
  if (!okTok && !okAdmin) return res.status(403).json({ error: 'Only the creator can edit this tournament.' });
  const name = clean(req.body.name, 80);
  if (!name) return res.status(400).json({ error: 'Give the tournament a name.' });
  const renames = Array.isArray(req.body.rename) ? req.body.rename : [];
  let rows, cover = null;
  try { rows = parseNew(Array.isArray(req.body.add) ? req.body.add : []); if (req.body.cover) cover = parseJpeg(req.body.cover); } catch (e) { return res.status(400).json({ error: e.message }); }
  const count = db.prepare('SELECT COUNT(*) c FROM items WHERE tid=?').get(req.params.id).c;
  if (count + rows.length > 40) return res.status(400).json({ error: 'A tournament can have at most 40 entries.' });
  tx(() => {
    db.prepare('UPDATE tournaments SET name=? WHERE id=?').run(name, req.params.id);
    if (cover) db.prepare('UPDATE tournaments SET cover=? WHERE id=?').run(cover, req.params.id);
    else if (req.body.removeCover) db.prepare('UPDATE tournaments SET cover=NULL WHERE id=?').run(req.params.id);
    const ren = db.prepare('UPDATE items SET name=? WHERE id=? AND tid=?');
    renames.forEach(r => ren.run(clean(r.name, 80) || 'Untitled', String(r.id), req.params.id));
    const ins = db.prepare('INSERT INTO items(id,tid,name,img) VALUES(?,?,?,?)');
    rows.forEach(r => ins.run(r.id, req.params.id, r.name, r.img));
  })();
  res.json({ ok: true });
});

app.delete('/api/tournaments/:id', (req, res) => {
  const t = db.prepare('SELECT delete_token FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  const okTok = req.get('x-delete-token') === t.delete_token;
  const okAdmin = ADMIN_KEY && req.get('x-admin-key') === ADMIN_KEY;
  if (!okTok && !okAdmin) return res.status(403).json({ error: 'Not allowed.' });
  tx(() => {
    db.prepare('DELETE FROM votes WHERE tid=?').run(req.params.id);
    db.prepare('DELETE FROM tournaments WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

app.get('/cover/:id', (req, res) => {
  const r = db.prepare('SELECT cover FROM tournaments WHERE id=?').get(req.params.id);
  if (!r || !r.cover) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(r.cover));
});

app.get('/img/:id', (req, res) => {
  const r = db.prepare('SELECT img FROM items WHERE id=?').get(req.params.id);
  if (!r) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(r.img));
});

app.listen(PORT, () => console.log('Greatest of them all running on http://localhost:' + PORT));
