// index.js — Hono API on Node.js, SQLite-backed, password-gated.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { extractPlaces, generateGuide } from './llm.js';

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
  CREATE TABLE IF NOT EXISTS place_cache (
    board_id    TEXT NOT NULL,
    day_date    TEXT NOT NULL,
    items_hash  TEXT NOT NULL,
    places_json TEXT NOT NULL,
    source      TEXT NOT NULL,
    cached_at   INTEGER NOT NULL,
    PRIMARY KEY (board_id, day_date)
  );
  CREATE TABLE IF NOT EXISTS guide_cache (
    board_id   TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    item_hash  TEXT NOT NULL,
    content    TEXT NOT NULL,
    cached_at  INTEGER NOT NULL,
    PRIMARY KEY (board_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS hidden_items (
    board_id TEXT NOT NULL,
    item_id  TEXT NOT NULL,
    PRIMARY KEY (board_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS board_settings (
    board_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (board_id, key)
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
  getPlaceCache: db.prepare('SELECT items_hash, places_json, source, cached_at FROM place_cache WHERE board_id = ? AND day_date = ?'),
  setPlaceCache: db.prepare(`
    INSERT INTO place_cache (board_id, day_date, items_hash, places_json, source, cached_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(board_id, day_date) DO UPDATE SET
      items_hash = excluded.items_hash,
      places_json = excluded.places_json,
      source = excluded.source,
      cached_at = excluded.cached_at
  `),
  clearPlaceCacheForBoard: db.prepare('DELETE FROM place_cache WHERE board_id = ?'),

  getGuideCache: db.prepare('SELECT item_hash, content, cached_at FROM guide_cache WHERE board_id = ? AND item_id = ?'),
  setGuideCache: db.prepare(`
    INSERT INTO guide_cache (board_id, item_id, item_hash, content, cached_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(board_id, item_id) DO UPDATE SET
      item_hash = excluded.item_hash,
      content = excluded.content,
      cached_at = excluded.cached_at
  `),
  clearGuideCacheForBoard: db.prepare('DELETE FROM guide_cache WHERE board_id = ?'),

  listHidden: db.prepare('SELECT item_id FROM hidden_items WHERE board_id = ?'),
  addHidden: db.prepare('INSERT OR IGNORE INTO hidden_items (board_id, item_id) VALUES (?, ?)'),
  removeHidden: db.prepare('DELETE FROM hidden_items WHERE board_id = ? AND item_id = ?'),
  clearHiddenForBoard: db.prepare('DELETE FROM hidden_items WHERE board_id = ?'),

  listBoardSettings: db.prepare('SELECT key, value FROM board_settings WHERE board_id = ?'),
  setBoardSetting: db.prepare(`
    INSERT INTO board_settings (board_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(board_id, key) DO UPDATE SET value = excluded.value
  `),
  clearBoardSettings: db.prepare('DELETE FROM board_settings WHERE board_id = ?'),
  renameBoard: db.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?'),
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
  const id = c.req.param('id');
  stmt.clearPlaceCacheForBoard.run(id);
  stmt.clearGuideCacheForBoard.run(id);
  stmt.clearHiddenForBoard.run(id);
  stmt.clearBoardSettings.run(id);
  stmt.deleteBoard.run(id);
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

// Places: resolve a day's items to clean geocodable place names.
// Body: { city: "維也納", items: [{id,title,place?}, ...] }
// Returns: { source: "cache" | "llm" | "fallback", places: [{id,q}, ...] }
app.post('/api/boards/:id/places/:date', async (c) => {
  const boardId = c.req.param('id');
  const dayDate = c.req.param('date');
  const refresh = c.req.query('refresh') === '1';

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const items = Array.isArray(body?.items) ? body.items : [];
  const city = typeof body?.city === 'string' ? body.city : '';

  // Hash of inputs — invalidates cache when the day's items change
  const hash = createHash('sha1')
    .update(city + '|' + items.map(it => `${it.id}\t${it.title || ''}\t${it.place || ''}`).join('\n'))
    .digest('hex');

  if (!refresh) {
    const cached = stmt.getPlaceCache.get(boardId, dayDate);
    if (cached && cached.items_hash === hash) {
      return c.json({
        source: cached.source === 'llm' ? 'cache' : 'cache_fallback',
        places: JSON.parse(cached.places_json),
        cached_at: cached.cached_at,
      });
    }
  }

  // Try LLM
  let places = null;
  let source = 'llm';
  try {
    places = await extractPlaces(city, items);
  } catch (e) {
    console.warn(`[places] LLM failed for ${boardId}/${dayDate}: ${e.message}`);
    places = null;
  }

  if (!places || places.length === 0) {
    // Fallback: return items as-is so the client uses its regex-based extractor
    source = 'fallback';
    places = items.map(it => ({ id: it.id, q: (it.place || it.title || '').trim() })).filter(x => x.q);
  }

  stmt.setPlaceCache.run(boardId, dayDate, hash, JSON.stringify(places), source, Date.now());
  return c.json({ source, places });
});

// AI guide for a single item. Lazy-loaded: called when user expands the card.
// Body: { item: {id, title, category, place?, desc?}, city: "..." }
// Returns: { source: "cache" | "llm", content: "...", cached_at }
app.post('/api/boards/:id/items/:itemId/guide', async (c) => {
  const boardId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const refresh = c.req.query('refresh') === '1';

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const item = body?.item;
  const city = typeof body?.city === 'string' ? body.city : '';
  if (!item || typeof item !== 'object' || !item.title) {
    return c.json({ error: 'item.title required' }, 400);
  }

  // Read preference for this board (used both in prompt + hash)
  const settings = boardSettingsObj(boardId);
  const preference = settings.preference || '';

  const hash = createHash('sha1')
    .update([item.title || '', item.place || '', item.desc || '', item.category?.type || '', city, preference].join('|'))
    .digest('hex');

  if (!refresh) {
    const cached = stmt.getGuideCache.get(boardId, itemId);
    if (cached && cached.item_hash === hash) {
      return c.json({ source: 'cache', content: cached.content, cached_at: cached.cached_at });
    }
  }

  let content;
  try {
    content = await generateGuide(item, city, preference);
  } catch (e) {
    return c.json({ error: 'LLM failed: ' + e.message }, 502);
  }
  if (!content) return c.json({ error: 'empty response' }, 502);

  stmt.setGuideCache.run(boardId, itemId, hash, content, Date.now());
  return c.json({ source: 'llm', content });
});

// Hidden items
app.get('/api/boards/:id/hidden', (c) => {
  const rows = stmt.listHidden.all(c.req.param('id'));
  return c.json({ hidden: rows.map(r => r.item_id) });
});

app.post('/api/boards/:id/hidden', async (c) => {
  const boardId = c.req.param('id');
  const body = await c.req.json();
  if (!body || typeof body.item_id !== 'string' || typeof body.hidden !== 'boolean') {
    return c.json({ error: 'expected { item_id, hidden }' }, 400);
  }
  if (body.hidden) stmt.addHidden.run(boardId, body.item_id);
  else stmt.removeHidden.run(boardId, body.item_id);
  return c.json({ ok: true });
});

// Board settings (key-value): "preference" used by AI guide; future-proof for more.
app.get('/api/boards/:id/settings', (c) => {
  return c.json(boardSettingsObj(c.req.param('id')));
});

app.put('/api/boards/:id/settings', async (c) => {
  const boardId = c.req.param('id');
  const body = await c.req.json();
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid' }, 400);
  if (typeof body.name === 'string' && body.name.trim()) {
    stmt.renameBoard.run(body.name.trim(), Date.now(), boardId);
  }
  if (body.settings && typeof body.settings === 'object') {
    for (const [k, v] of Object.entries(body.settings)) {
      stmt.setBoardSetting.run(boardId, k, String(v ?? ''));
    }
  }
  return c.json({ ok: true });
});

// Clear all AI caches (places + guide) for a board.
app.delete('/api/boards/:id/cache', (c) => {
  const boardId = c.req.param('id');
  stmt.clearPlaceCacheForBoard.run(boardId);
  stmt.clearGuideCacheForBoard.run(boardId);
  return c.json({ ok: true });
});

function boardSettingsObj(boardId) {
  const rows = stmt.listBoardSettings.all(boardId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

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
