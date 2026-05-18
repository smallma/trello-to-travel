// index.js — Hono API on Node.js, SQLite-backed, password-gated.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const PORT = parseInt(process.env.PORT || '5566', 10);
const PASSWORD = process.env.API_PASSWORD;
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, '..');
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

if (!PASSWORD) {
  console.error('FATAL: API_PASSWORD env var is required.');
  process.exit(1);
}
if (!GOOGLE_MAPS_KEY) {
  console.warn('WARN: GOOGLE_MAPS_KEY is empty — map embeds will not work.');
}

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// --- DB ---
const db = new Database(join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    raw_json    TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS route_off (
    board_id TEXT NOT NULL,
    item_id  TEXT NOT NULL,
    PRIMARY KEY (board_id, item_id),
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const stmt = {
  listBoards: db.prepare('SELECT id, name, imported_at, updated_at FROM boards ORDER BY updated_at DESC'),
  getBoard:   db.prepare('SELECT id, name, raw_json, imported_at, updated_at FROM boards WHERE id = ?'),
  upsertBoard: db.prepare(`
    INSERT INTO boards (id, name, raw_json, imported_at, updated_at)
    VALUES (@id, @name, @raw_json, @imported_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `),
  deleteBoard: db.prepare('DELETE FROM boards WHERE id = ?'),
  listRouteOff: db.prepare('SELECT item_id FROM route_off WHERE board_id = ?'),
  insertRouteOff: db.prepare('INSERT OR IGNORE INTO route_off (board_id, item_id) VALUES (?, ?)'),
  deleteRouteOff: db.prepare('DELETE FROM route_off WHERE board_id = ? AND item_id = ?'),
  clearRouteOff: db.prepare('DELETE FROM route_off WHERE board_id = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

// --- App ---
const app = new Hono();

// Auth middleware for /api/*
app.use('/api/*', async (c, next) => {
  // Always allow auth check endpoint without a password (used by frontend probe)
  if (c.req.path === '/api/ping') return next();
  const pw = c.req.header('X-API-Password') || '';
  if (pw !== PASSWORD) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

// --- Routes ---
app.get('/api/ping', (c) => c.json({ ok: true }));

app.post('/api/auth/check', (c) => c.json({ ok: true })); // returns 200 only if middleware passed

// Frontend config (Maps API key etc) — only handed out after password check
app.get('/api/config', (c) => c.json({
  google_maps_key: GOOGLE_MAPS_KEY,
}));

// List boards (metadata only)
app.get('/api/boards', (c) => {
  const rows = stmt.listBoards.all();
  return c.json({ boards: rows });
});

// Get one board (full)
app.get('/api/boards/:id', (c) => {
  const row = stmt.getBoard.get(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({
    id: row.id,
    name: row.name,
    raw: JSON.parse(row.raw_json),
    imported_at: row.imported_at,
    updated_at: row.updated_at,
  });
});

// Create/replace board (PUT with id from raw.shortLink or raw.id)
app.put('/api/boards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (!body || !body.raw || typeof body.raw !== 'object') {
    return c.json({ error: 'missing raw' }, 400);
  }
  const now = Date.now();
  const existing = stmt.getBoard.get(id);
  stmt.upsertBoard.run({
    id,
    name: body.raw.name || '未命名行程',
    raw_json: JSON.stringify(body.raw),
    imported_at: existing ? existing.imported_at : now,
    updated_at: now,
  });
  return c.json({ ok: true, id });
});

// Delete board
app.delete('/api/boards/:id', (c) => {
  stmt.deleteBoard.run(c.req.param('id'));
  return c.json({ ok: true });
});

// Get route-off set for a board
app.get('/api/boards/:id/route-off', (c) => {
  const rows = stmt.listRouteOff.all(c.req.param('id'));
  const off = {};
  for (const r of rows) off[r.item_id] = true;
  return c.json({ route_off: off });
});

// Toggle one item's route inclusion
app.post('/api/boards/:id/route-off', async (c) => {
  const boardId = c.req.param('id');
  const body = await c.req.json();
  if (!body || typeof body.item_id !== 'string' || typeof body.off !== 'boolean') {
    return c.json({ error: 'expected { item_id, off }' }, 400);
  }
  if (body.off) stmt.insertRouteOff.run(boardId, body.item_id);
  else stmt.deleteRouteOff.run(boardId, body.item_id);
  return c.json({ ok: true });
});

// Setting: active board id (so the same user gets the same board on any device)
app.get('/api/settings/active', (c) => {
  const row = stmt.getSetting.get('active_board_id');
  return c.json({ active_board_id: row ? row.value : null });
});

app.put('/api/settings/active', async (c) => {
  const body = await c.req.json();
  const id = body && typeof body.active_board_id === 'string' ? body.active_board_id : '';
  if (id) stmt.setSetting.run('active_board_id', id);
  else db.prepare('DELETE FROM settings WHERE key = ?').run('active_board_id');
  return c.json({ ok: true });
});

// --- Static frontend ---
app.use('/*', serveStatic({
  root: STATIC_DIR,
  rewriteRequestPath: (path) => path === '/' ? '/index.html' : path,
}));

console.log(`Listening on http://127.0.0.1:${PORT}`);
console.log(`Static dir: ${STATIC_DIR}`);
console.log(`Data dir:   ${DATA_DIR}`);
serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
