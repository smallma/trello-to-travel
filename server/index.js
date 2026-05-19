// index.js — Hono API on Node.js, SQLite-backed, password-gated.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, createReadStream, statfsSync, writeFileSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { readFile } from 'fs/promises';
import { extractPlaces, generateGuide, generateAnswer } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(DATA_DIR, 'uploads');
const PORT = parseInt(process.env.PORT || '5566', 10);
const PASSWORD = process.env.API_PASSWORD;
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, '..');

const MAX_FILE_BYTES = 10 * 1024 * 1024;      // 10 MB per file
const MAX_IMAGES_PER_ITEM = 20;
const MAX_FILES_PER_ITEM = 30;                 // images + other
const MAX_UPLOAD_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;  // 5 GB total
const MIN_DISK_FREE_BYTES = 500 * 1024 * 1024; // require 500 MB free

if (!PASSWORD) {
  console.error('FATAL: API_PASSWORD env var is required.');
  process.exit(1);
}
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

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
  CREATE TABLE IF NOT EXISTS custom_items (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL,
    day_date    TEXT NOT NULL,
    payload     TEXT NOT NULL,
    pos         REAL NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_custom_items_board_day ON custom_items(board_id, day_date);
  CREATE TABLE IF NOT EXISTS item_overrides (
    board_id TEXT NOT NULL,
    item_id  TEXT NOT NULL,
    payload  TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS geocode_cache (
    q          TEXT PRIMARY KEY,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    display    TEXT,
    cached_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS item_order (
    board_id  TEXT NOT NULL,
    item_id   TEXT NOT NULL,
    day_date  TEXT NOT NULL,
    pos       REAL NOT NULL,
    PRIMARY KEY (board_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_item_order_day ON item_order(board_id, day_date);
  CREATE TABLE IF NOT EXISTS day_order (
    board_id  TEXT NOT NULL,
    day_date  TEXT NOT NULL,
    pos       REAL NOT NULL,
    PRIMARY KEY (board_id, day_date)
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id            TEXT PRIMARY KEY,
    board_id      TEXT NOT NULL,
    item_id       TEXT NOT NULL,
    kind          TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    rel_path      TEXT NOT NULL,
    thumb_path    TEXT,
    medium_path   TEXT,
    pos           REAL NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_att_item ON attachments(board_id, item_id);
  CREATE TABLE IF NOT EXISTS qa (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_qa_item ON qa(board_id, item_id, created_at);
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

  // Custom items
  listCustomItems: db.prepare('SELECT id, day_date, payload, pos FROM custom_items WHERE board_id = ? ORDER BY day_date, pos'),
  listCustomItemsForDay: db.prepare('SELECT id, payload, pos FROM custom_items WHERE board_id = ? AND day_date = ? ORDER BY pos'),
  getCustomItem: db.prepare('SELECT id, board_id, day_date, payload, pos FROM custom_items WHERE id = ?'),
  insertCustomItem: db.prepare(`
    INSERT INTO custom_items (id, board_id, day_date, payload, pos, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateCustomItem: db.prepare('UPDATE custom_items SET payload = ?, pos = ?, day_date = ?, updated_at = ? WHERE id = ?'),
  deleteCustomItem: db.prepare('DELETE FROM custom_items WHERE id = ?'),
  clearCustomItemsForBoard: db.prepare('DELETE FROM custom_items WHERE board_id = ?'),
  maxPosForDay: db.prepare('SELECT MAX(pos) AS m FROM custom_items WHERE board_id = ? AND day_date = ?'),

  // Item overrides (for editing Trello cards without mutating raw)
  listOverrides: db.prepare('SELECT item_id, payload FROM item_overrides WHERE board_id = ?'),
  getOverride: db.prepare('SELECT payload FROM item_overrides WHERE board_id = ? AND item_id = ?'),
  upsertOverride: db.prepare(`
    INSERT INTO item_overrides (board_id, item_id, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(board_id, item_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `),
  deleteOverride: db.prepare('DELETE FROM item_overrides WHERE board_id = ? AND item_id = ?'),
  clearOverridesForBoard: db.prepare('DELETE FROM item_overrides WHERE board_id = ?'),

  // Geocode cache
  getGeo: db.prepare('SELECT lat, lng, display, cached_at FROM geocode_cache WHERE q = ?'),
  setGeo: db.prepare(`
    INSERT INTO geocode_cache (q, lat, lng, display, cached_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(q) DO UPDATE SET
      lat = excluded.lat, lng = excluded.lng,
      display = excluded.display, cached_at = excluded.cached_at
  `),

  // Item / day reorder
  listItemOrder: db.prepare('SELECT item_id, day_date, pos FROM item_order WHERE board_id = ?'),
  upsertItemOrder: db.prepare(`
    INSERT INTO item_order (board_id, item_id, day_date, pos)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(board_id, item_id) DO UPDATE SET
      day_date = excluded.day_date,
      pos = excluded.pos
  `),
  deleteItemOrder: db.prepare('DELETE FROM item_order WHERE board_id = ? AND item_id = ?'),
  clearItemOrderForBoard: db.prepare('DELETE FROM item_order WHERE board_id = ?'),

  listDayOrder: db.prepare('SELECT day_date, pos FROM day_order WHERE board_id = ?'),
  upsertDayOrder: db.prepare(`
    INSERT INTO day_order (board_id, day_date, pos)
    VALUES (?, ?, ?)
    ON CONFLICT(board_id, day_date) DO UPDATE SET pos = excluded.pos
  `),
  clearDayOrderForBoard: db.prepare('DELETE FROM day_order WHERE board_id = ?'),

  // Attachments
  listAttachmentsForBoard: db.prepare('SELECT * FROM attachments WHERE board_id = ? ORDER BY item_id, pos'),
  listAttachmentsForItem: db.prepare('SELECT * FROM attachments WHERE board_id = ? AND item_id = ? ORDER BY pos'),
  getAttachment: db.prepare('SELECT * FROM attachments WHERE id = ?'),
  insertAttachment: db.prepare(`
    INSERT INTO attachments (id, board_id, item_id, kind, original_name, mime, size, rel_path, thumb_path, medium_path, pos, created_at)
    VALUES (@id, @board_id, @item_id, @kind, @original_name, @mime, @size, @rel_path, @thumb_path, @medium_path, @pos, @created_at)
  `),
  deleteAttachment: db.prepare('DELETE FROM attachments WHERE id = ?'),
  clearAttachmentsForBoard: db.prepare('DELETE FROM attachments WHERE board_id = ?'),
  clearAttachmentsForItem: db.prepare('DELETE FROM attachments WHERE board_id = ? AND item_id = ?'),
  countAttachmentsForItem: db.prepare('SELECT COUNT(*) AS c, COUNT(CASE WHEN kind=\'image\' THEN 1 END) AS img FROM attachments WHERE board_id = ? AND item_id = ?'),
  totalUploadSize: db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM attachments'),
  maxAttachmentPos: db.prepare('SELECT MAX(pos) AS m FROM attachments WHERE board_id = ? AND item_id = ?'),

  // Q&A
  listQa: db.prepare('SELECT id, item_id, question, answer, source, created_at FROM qa WHERE board_id = ? AND item_id = ? ORDER BY created_at'),
  listQaForBoard: db.prepare('SELECT id, item_id, question, answer, source, created_at FROM qa WHERE board_id = ?'),
  insertQa: db.prepare('INSERT INTO qa (id, board_id, item_id, question, answer, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  deleteQa: db.prepare('DELETE FROM qa WHERE id = ?'),
  clearQaForItem: db.prepare('DELETE FROM qa WHERE board_id = ? AND item_id = ?'),
  clearQaForBoard: db.prepare('DELETE FROM qa WHERE board_id = ?'),
};

// --- App ---
const app = new Hono();

// Auth middleware for /api/*
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/ping') return next();
  // Allow attachment streams via query token (for <img src>, downloads)
  const fromHeader = c.req.header('X-API-Password') || '';
  const fromQuery = c.req.query('pw') || '';
  const pw = fromHeader || fromQuery;
  if (pw !== PASSWORD) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

// --- Routes ---
app.get('/api/ping', (c) => c.json({ ok: true }));

app.post('/api/auth/check', (c) => c.json({ ok: true })); // returns 200 only if middleware passed

// Frontend config — no secrets, just feature flags
app.get('/api/config', (c) => c.json({
  map: 'leaflet',
  features: {
    llm: !!process.env.MINIMAX_API_KEY,
    search: !!process.env.TAVILY_API_KEY,
    attachments: true,
    backup: true,
  },
  limits: {
    max_file_mb: MAX_FILE_BYTES / 1024 / 1024,
    max_images_per_item: MAX_IMAGES_PER_ITEM,
    max_files_per_item: MAX_FILES_PER_ITEM,
  },
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
  // Best-effort: also wipe the uploads dir for this board
  try {
    const dir = join(UPLOAD_DIR, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {}
  stmt.clearPlaceCacheForBoard.run(id);
  stmt.clearGuideCacheForBoard.run(id);
  stmt.clearHiddenForBoard.run(id);
  stmt.clearBoardSettings.run(id);
  stmt.clearCustomItemsForBoard.run(id);
  stmt.clearOverridesForBoard.run(id);
  stmt.clearItemOrderForBoard.run(id);
  stmt.clearDayOrderForBoard.run(id);
  stmt.clearAttachmentsForBoard.run(id);
  stmt.clearQaForBoard.run(id);
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
  const useSearch = c.req.query('search') === '1';

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const item = body?.item;
  const city = typeof body?.city === 'string' ? body.city : '';
  if (!item || typeof item !== 'object' || !item.title) {
    return c.json({ error: 'item.title required' }, 400);
  }

  const settings = boardSettingsObj(boardId);
  const preference = settings.preference || '';

  // Hash includes search flag so search vs non-search are separate cache rows
  const hash = createHash('sha1')
    .update([item.title || '', item.place || '', item.desc || '', item.category?.type || '', city, preference, useSearch ? 's' : 'n'].join('|'))
    .digest('hex');

  if (!refresh) {
    const cached = stmt.getGuideCache.get(boardId, itemId);
    if (cached && cached.item_hash === hash) {
      return c.json({ source: 'cache', content: cached.content, cached_at: cached.cached_at });
    }
  }

  let content;
  try {
    content = await generateGuide(item, city, preference, { use_search: useSearch });
  } catch (e) {
    return c.json({ error: 'LLM failed: ' + e.message }, 502);
  }
  if (!content) return c.json({ error: 'empty response' }, 502);

  stmt.setGuideCache.run(boardId, itemId, hash, content, Date.now());
  return c.json({ source: useSearch ? 'search' : 'llm', content });
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

// ===== Attachments =====
// Disk-space + total-quota guard
function diskGuard(extraBytes = 0) {
  // 1) per-file size already enforced at upload time
  // 2) total upload quota
  const total = stmt.totalUploadSize.get().s + extraBytes;
  if (total > MAX_UPLOAD_TOTAL_BYTES) {
    return { ok: false, code: 507, error: `總上傳量超過上限 (${(MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024 / 1024).toFixed(0)} GB)` };
  }
  // 3) disk free space
  try {
    const s = statfsSync(UPLOAD_DIR);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < MIN_DISK_FREE_BYTES + extraBytes) {
      return { ok: false, code: 507, error: `主機磁碟空間不足（剩 ${(free / 1024 / 1024).toFixed(0)} MB）` };
    }
  } catch {} // statfsSync absent on some platforms; skip
  return { ok: true };
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const BLOCKED_EXTS = new Set(['.exe', '.bat', '.cmd', '.sh', '.app', '.scr', '.js', '.vbs']);

// List attachments for a board (lets the parser merge them in)
app.get('/api/boards/:id/attachments', (c) => {
  const rows = stmt.listAttachmentsForBoard.all(c.req.param('id'));
  return c.json({ attachments: rows.map(toAttachmentDTO) });
});

// Upload one or more attachments to an item
app.post('/api/boards/:id/items/:itemId/attachments', async (c) => {
  const boardId = c.req.param('id');
  const itemId = c.req.param('itemId');

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'expected multipart/form-data' }, 400);

  const files = form.getAll('file').filter(f => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (files.length === 0) return c.json({ error: 'no file' }, 400);

  // Counts guard
  const counts = stmt.countAttachmentsForItem.get(boardId, itemId);
  const newImages = files.filter(f => IMAGE_MIMES.has(f.type)).length;
  if (counts.c + files.length > MAX_FILES_PER_ITEM) {
    return c.json({ error: `每張卡片附件上限 ${MAX_FILES_PER_ITEM} 個` }, 400);
  }
  if (counts.img + newImages > MAX_IMAGES_PER_ITEM) {
    return c.json({ error: `每張卡片圖片上限 ${MAX_IMAGES_PER_ITEM} 張` }, 400);
  }

  const results = [];
  for (const file of files) {
    const ext = (extname(file.name || '') || '').toLowerCase();
    if (BLOCKED_EXTS.has(ext)) {
      return c.json({ error: `不允許的副檔名：${ext}` }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return c.json({ error: `${file.name} 超過單檔上限 ${(MAX_FILE_BYTES / 1024 / 1024)} MB` }, 413);
    }
    const guard = diskGuard(file.size);
    if (!guard.ok) return c.json({ error: guard.error }, guard.code);

    const buf = Buffer.from(await file.arrayBuffer());
    const id = 'att_' + randomBytes(10).toString('hex');
    const isImage = IMAGE_MIMES.has(file.type);
    const safeName = (file.name || 'file').replace(/[^\w.一-龥\-]/g, '_').slice(0, 100);

    const itemDir = join(UPLOAD_DIR, boardId, itemId);
    if (!existsSync(itemDir)) mkdirSync(itemDir, { recursive: true });

    const origFile = `${id}${ext || ''}`;
    const origPath = join(itemDir, origFile);
    await writeFile(origPath, buf);

    let thumbPath = null;
    let mediumPath = null;
    if (isImage) {
      const thumbFile = `${id}_thumb.webp`;
      const mediumFile = `${id}_medium.webp`;
      try {
        await sharp(buf).rotate().resize(300, 300, { fit: 'cover' }).webp({ quality: 70 }).toFile(join(itemDir, thumbFile));
        thumbPath = `${boardId}/${itemId}/${thumbFile}`;
      } catch (e) { console.warn('thumb gen failed', e.message); }
      try {
        await sharp(buf).rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(join(itemDir, mediumFile));
        mediumPath = `${boardId}/${itemId}/${mediumFile}`;
      } catch (e) { console.warn('medium gen failed', e.message); }
    }

    const posRow = stmt.maxAttachmentPos.get(boardId, itemId);
    const pos = (posRow?.m || 0) + 1024;
    stmt.insertAttachment.run({
      id, board_id: boardId, item_id: itemId,
      kind: isImage ? 'image' : 'file',
      original_name: safeName,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      rel_path: `${boardId}/${itemId}/${origFile}`,
      thumb_path: thumbPath, medium_path: mediumPath,
      pos, created_at: Date.now(),
    });
    results.push({ id, original_name: safeName, kind: isImage ? 'image' : 'file' });
  }
  return c.json({ ok: true, attachments: results });
});

// Delete one attachment
app.delete('/api/attachments/:id', async (c) => {
  const a = stmt.getAttachment.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  for (const p of [a.rel_path, a.thumb_path, a.medium_path]) {
    if (!p) continue;
    try { await unlink(join(UPLOAD_DIR, p)); } catch {}
  }
  stmt.deleteAttachment.run(a.id);
  return c.json({ ok: true });
});

// Serve attachment files
function streamFile(c, fullPath, fallbackMime) {
  if (!existsSync(fullPath)) return c.json({ error: 'not found' }, 404);
  const stream = createReadStream(fullPath);
  return new Response(stream, {
    headers: { 'Content-Type': fallbackMime, 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}
app.get('/api/attachments/:id/thumb', (c) => {
  const a = stmt.getAttachment.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  return streamFile(c, join(UPLOAD_DIR, a.thumb_path || a.rel_path), 'image/webp');
});
app.get('/api/attachments/:id/medium', (c) => {
  const a = stmt.getAttachment.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  return streamFile(c, join(UPLOAD_DIR, a.medium_path || a.rel_path), 'image/webp');
});
app.get('/api/attachments/:id/original', (c) => {
  const a = stmt.getAttachment.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  if (!existsSync(join(UPLOAD_DIR, a.rel_path))) return c.json({ error: 'not found' }, 404);
  const stream = createReadStream(join(UPLOAD_DIR, a.rel_path));
  return new Response(stream, {
    headers: {
      'Content-Type': a.mime,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.original_name)}`,
    },
  });
});

function toAttachmentDTO(row) {
  return {
    id: row.id,
    item_id: row.item_id,
    kind: row.kind,
    original_name: row.original_name,
    mime: row.mime,
    size: row.size,
    pos: row.pos,
  };
}

// ===== Custom items =====
// List all custom items + overrides + user-defined order for a board.
app.get('/api/boards/:id/extras', (c) => {
  const id = c.req.param('id');
  // Skip drafts so they never show up in the timeline
  const custom = stmt.listCustomItems.all(id)
    .map(r => ({ id: r.id, day_date: r.day_date, pos: r.pos, ...JSON.parse(r.payload) }))
    .filter(it => it.title !== DRAFT_TITLE);
  const overrides = {};
  for (const r of stmt.listOverrides.all(id)) {
    overrides[r.item_id] = JSON.parse(r.payload);
  }
  const itemOrder = {}; // item_id -> {day_date, pos}
  for (const r of stmt.listItemOrder.all(id)) {
    itemOrder[r.item_id] = { day_date: r.day_date, pos: r.pos };
  }
  const dayOrder = {}; // day_date -> pos
  for (const r of stmt.listDayOrder.all(id)) {
    dayOrder[r.day_date] = r.pos;
  }
  return c.json({ custom, overrides, item_order: itemOrder, day_order: dayOrder });
});

// Reorder cards within a day OR move cards across days.
// Body: { day_date: "6/19", item_ids: ["id1","id2",...] }
//   - item_ids is the FULL ordered list for that day after the drop
//   - server writes per-item user_pos (1024, 2048, 3072, ...) and updates day_date
app.put('/api/boards/:id/days/:date/order', async (c) => {
  const boardId = c.req.param('id');
  const dayDate = c.req.param('date');
  const body = await c.req.json();
  if (!body || !Array.isArray(body.item_ids)) {
    return c.json({ error: 'item_ids required' }, 400);
  }
  const tx = db.transaction((ids) => {
    ids.forEach((itemId, idx) => {
      if (typeof itemId !== 'string') return;
      const pos = (idx + 1) * 1024;
      stmt.upsertItemOrder.run(boardId, itemId, dayDate, pos);
      // If it's a custom item, also sync its native row so list_extras works
      const cust = stmt.getCustomItem.get(itemId);
      if (cust && cust.board_id === boardId) {
        stmt.updateCustomItem.run(cust.payload, pos, dayDate, Date.now(), itemId);
      }
    });
  });
  tx(body.item_ids);
  return c.json({ ok: true });
});

// Reorder days. Body: { day_dates: ["6/22 米蘭","6/18 維也納",...] }
app.put('/api/boards/:id/day-order', async (c) => {
  const boardId = c.req.param('id');
  const body = await c.req.json();
  if (!body || !Array.isArray(body.day_dates)) {
    return c.json({ error: 'day_dates required' }, 400);
  }
  const tx = db.transaction((arr) => {
    arr.forEach((d, idx) => {
      if (typeof d !== 'string') return;
      stmt.upsertDayOrder.run(boardId, d, (idx + 1) * 1024);
    });
  });
  tx(body.day_dates);
  return c.json({ ok: true });
});

// Create an empty draft item for the day. Used when the user clicks "+ 新增"
// so they can upload attachments before filling in the form. The draft is
// invisible in the UI (filtered by its DRAFT marker title) until the user
// hits Save (which calls PUT /items/:itemId to finalize).
const DRAFT_TITLE = '__DRAFT__';

app.post('/api/boards/:id/days/:date/draft', (c) => {
  const boardId = c.req.param('id');
  const dayDate = c.req.param('date');
  const id = 'cust_' + randomBytes(10).toString('hex');
  const maxRow = stmt.maxPosForDay.get(boardId, dayDate);
  const pos = (maxRow?.m || 0) + 1024;
  const now = Date.now();
  stmt.insertCustomItem.run(id, boardId, dayDate, JSON.stringify({ title: DRAFT_TITLE, _draft: true }), pos, now, now);
  return c.json({ ok: true, id });
});

// Create a custom item for a specific day.
app.post('/api/boards/:id/days/:date/items', async (c) => {
  const boardId = c.req.param('id');
  const dayDate = c.req.param('date');
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || !body.title) {
    return c.json({ error: 'title required' }, 400);
  }
  const id = 'cust_' + Math.random().toString(36).slice(2, 12);
  const maxRow = stmt.maxPosForDay.get(boardId, dayDate);
  const pos = (maxRow?.m || 0) + 1024;
  const payload = sanitizeItemPayload(body);
  const now = Date.now();
  stmt.insertCustomItem.run(id, boardId, dayDate, JSON.stringify(payload), pos, now, now);
  return c.json({ ok: true, id });
});

// Update a custom item or override a Trello item.
app.put('/api/boards/:id/items/:itemId', async (c) => {
  const boardId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const body = await c.req.json();
  const payload = sanitizeItemPayload(body || {});
  const existingCustom = stmt.getCustomItem.get(itemId);
  if (existingCustom && existingCustom.board_id === boardId) {
    const dayDate = (typeof body?.day_date === 'string') ? body.day_date : existingCustom.day_date;
    stmt.updateCustomItem.run(JSON.stringify(payload), existingCustom.pos, dayDate, Date.now(), itemId);
  } else {
    stmt.upsertOverride.run(boardId, itemId, JSON.stringify(payload), Date.now());
  }
  return c.json({ ok: true });
});

// Delete a custom item, or clear an override on a Trello item.
app.delete('/api/boards/:id/items/:itemId', (c) => {
  const boardId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const existingCustom = stmt.getCustomItem.get(itemId);
  if (existingCustom && existingCustom.board_id === boardId) {
    stmt.deleteCustomItem.run(itemId);
  } else {
    stmt.deleteOverride.run(boardId, itemId);
  }
  return c.json({ ok: true });
});

function sanitizeItemPayload(input) {
  const out = {};
  if (input.title) out.title = String(input.title).slice(0, 200);
  if (input.desc) out.desc = String(input.desc).slice(0, 4000);
  if (input.category) out.category = input.category;
  if (input.time_start) out.time_start = String(input.time_start).slice(0, 10);
  if (input.time_end) out.time_end = String(input.time_end).slice(0, 10);
  if (input.place) out.place = String(input.place).slice(0, 200);
  if (Array.isArray(input.links)) out.links = input.links.filter(s => typeof s === 'string').slice(0, 10);
  if (Array.isArray(input.images)) out.images = input.images
    .filter(im => im && typeof im.thumb === 'string')
    .map(im => ({ thumb: im.thumb, full: im.full || im.thumb, name: im.name || '' }))
    .slice(0, 20);
  if (Array.isArray(input.labels)) out.labels = input.labels;
  return out;
}

// ===== Geocode proxy =====
// Cache → Nominatim → (on 429/error) Photon. All Nominatim calls serialized
// through a queue so we never violate the 1-req/s policy even under parallel
// browser fetches.
app.get('/api/geocode', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ error: 'q required' }, 400);
  const cached = stmt.getGeo.get(q);
  if (cached) {
    return c.json({ q, lat: cached.lat, lng: cached.lng, display: cached.display, source: 'cache' });
  }
  try {
    const hit = await geocodeOnce(q);
    if (!hit) return c.json({ q, lat: null, lng: null, source: 'miss' });
    stmt.setGeo.run(q, hit.lat, hit.lng, hit.display || '', Date.now());
    return c.json({ q, lat: hit.lat, lng: hit.lng, display: hit.display, source: hit.source });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

// --- Single-flight queue for Nominatim (1.2s gap between calls) ---
let _nominatimChain = Promise.resolve();
function queueNominatim(fn) {
  const next = _nominatimChain.then(async () => {
    const result = await fn();
    await new Promise(r => setTimeout(r, 1200));
    return result;
  });
  // Swallow rejection in the chain so one failure doesn't break the line
  _nominatimChain = next.catch(() => {});
  return next;
}

async function geocodeOnce(q) {
  // Try Nominatim first (better quality), Photon as backup
  try {
    const hit = await queueNominatim(() => fetchNominatim(q));
    if (hit) return hit;
  } catch (e) {
    console.warn(`[geocode] nominatim failed for "${q}": ${e.message}, trying photon`);
  }
  return await fetchPhoton(q);
}

async function fetchNominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'trello-to-travel/1.0 (private use; rainlin009@gmail.com)' },
  });
  if (res.status === 429) throw new Error('nominatim 429');
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return {
    lat: parseFloat(arr[0].lat),
    lng: parseFloat(arr[0].lon),
    display: arr[0].display_name || '',
    source: 'nominatim',
  };
}

async function fetchPhoton(q) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const f = j?.features?.[0];
  if (!f?.geometry?.coordinates) return null;
  const [lng, lat] = f.geometry.coordinates;
  return {
    lat, lng,
    display: f.properties?.name || '',
    source: 'photon',
  };
}

// ===== Backup / Restore =====
// Export one board as a .zip (DB rows + uploaded files for that board)
app.get('/api/boards/:id/export', async (c) => {
  const boardId = c.req.param('id');
  const board = stmt.getBoard.get(boardId);
  if (!board) return c.json({ error: 'not found' }, 404);

  const data = {
    version: 1,
    exported_at: Date.now(),
    board: {
      id: board.id,
      name: board.name,
      raw_json: JSON.parse(board.raw_json),
      imported_at: board.imported_at,
      updated_at: board.updated_at,
    },
    custom_items: stmt.listCustomItems.all(boardId),
    overrides: stmt.listOverrides.all(boardId),
    hidden: stmt.listHidden.all(boardId).map(r => r.item_id),
    settings: boardSettingsObj(boardId),
    item_order: stmt.listItemOrder.all(boardId),
    day_order: stmt.listDayOrder.all(boardId),
    route_off: db.prepare('SELECT item_id FROM route_off WHERE board_id = ?').all(boardId).map(r => r.item_id),
    guide_cache: db.prepare('SELECT item_id, item_hash, content, cached_at FROM guide_cache WHERE board_id = ?').all(boardId),
    place_cache: db.prepare('SELECT day_date, items_hash, places_json, source, cached_at FROM place_cache WHERE board_id = ?').all(boardId),
    qa: stmt.listQaForBoard.all(boardId),
    attachments: stmt.listAttachmentsForBoard.all(boardId),
  };

  const zip = new AdmZip();
  zip.addFile('board.json', Buffer.from(JSON.stringify(data, null, 2), 'utf8'));

  // Add uploaded files referenced by attachments
  for (const a of data.attachments) {
    for (const p of [a.rel_path, a.thumb_path, a.medium_path]) {
      if (!p) continue;
      const full = join(UPLOAD_DIR, p);
      if (existsSync(full)) {
        try {
          const buf = await readFile(full);
          zip.addFile(`uploads/${p}`, buf);
        } catch {}
      }
    }
  }

  const buf = zip.toBuffer();
  const niceName = `board-${board.id}-${Date.now()}.zip`;
  const fullName = `board-${board.name}-${Date.now()}.zip`;
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/zip',
      // RFC 5987 — ASCII fallback + UTF-8 encoded filename*
      'Content-Disposition': `attachment; filename="${niceName}"; filename*=UTF-8''${encodeURIComponent(fullName)}`,
    },
  });
});

// Import a board from a previously-exported .zip
app.post('/api/boards/import', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'expected multipart/form-data' }, 400);
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return c.json({ error: 'no file' }, 400);

  const guard = diskGuard(file.size);
  if (!guard.ok) return c.json({ error: guard.error }, guard.code);

  const buf = Buffer.from(await file.arrayBuffer());
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { return c.json({ error: 'invalid zip: ' + e.message }, 400); }

  const boardEntry = zip.getEntry('board.json');
  if (!boardEntry) return c.json({ error: 'board.json missing in zip' }, 400);

  let data;
  try { data = JSON.parse(boardEntry.getData().toString('utf8')); } catch (e) { return c.json({ error: 'board.json invalid: ' + e.message }, 400); }
  if (!data?.board) return c.json({ error: 'missing board' }, 400);

  // Assign new id (always, per Rain's spec) + bump name with suffix
  const newBoardId = 'imp_' + randomBytes(8).toString('hex');
  let newName = data.board.name || '匯入行程';
  // Disambiguate name if exists
  const existing = stmt.listBoards.all().map(r => r.name);
  if (existing.includes(newName)) {
    let n = 2;
    while (existing.includes(`${newName} (匯入 ${n})`)) n++;
    newName = `${newName} (匯入 ${n})`;
  }

  // ID-remap for items: custom items keep new ids; trello items keep original ids;
  // attachments / overrides / orders / qa key off the original item id which we keep.
  // (Custom items' ids must be remapped to avoid collision in custom_items PK.)
  const idMap = new Map();
  for (const c of data.custom_items || []) {
    const newItemId = 'cust_' + randomBytes(10).toString('hex');
    idMap.set(c.id, newItemId);
  }
  const mapId = (id) => idMap.get(id) || id;

  const tx = db.transaction(() => {
    const now = Date.now();
    stmt.upsertBoard.run({
      id: newBoardId,
      name: newName,
      raw_json: JSON.stringify(data.board.raw_json),
      imported_at: now,
      updated_at: now,
    });
    for (const ci of (data.custom_items || [])) {
      const newId = idMap.get(ci.id);
      stmt.insertCustomItem.run(newId, newBoardId, ci.day_date, ci.payload, ci.pos, now, now);
    }
    for (const ov of (data.overrides || [])) {
      stmt.upsertOverride.run(newBoardId, mapId(ov.item_id), ov.payload, now);
    }
    for (const hid of (data.hidden || [])) {
      stmt.addHidden.run(newBoardId, mapId(hid));
    }
    for (const [k, v] of Object.entries(data.settings || {})) {
      stmt.setBoardSetting.run(newBoardId, k, String(v));
    }
    for (const r of (data.item_order || [])) {
      stmt.upsertItemOrder.run(newBoardId, mapId(r.item_id), r.day_date, r.pos);
    }
    for (const r of (data.day_order || [])) {
      stmt.upsertDayOrder.run(newBoardId, r.day_date, r.pos);
    }
    for (const off of (data.route_off || [])) {
      stmt.insertRouteOff.run(newBoardId, mapId(off));
    }
    for (const g of (data.guide_cache || [])) {
      stmt.setGuideCache.run(newBoardId, mapId(g.item_id), g.item_hash, g.content, g.cached_at);
    }
    for (const p of (data.place_cache || [])) {
      stmt.setPlaceCache.run(newBoardId, p.day_date, p.items_hash, p.places_json, p.source, p.cached_at);
    }
    for (const q of (data.qa || [])) {
      const newQaId = 'qa_' + randomBytes(8).toString('hex');
      stmt.insertQa.run(newQaId, newBoardId, mapId(q.item_id), q.question, q.answer, q.source, q.created_at);
    }
    for (const a of (data.attachments || [])) {
      // attachments table stores rel_path under boardId/itemId/file — remap board+item parts
      const newId = 'att_' + randomBytes(10).toString('hex');
      const newItemId = mapId(a.item_id);
      const newRel = a.rel_path?.replace(`${data.board.id}/${a.item_id}`, `${newBoardId}/${newItemId}`)
                   ?? `${newBoardId}/${newItemId}/${newId}`;
      const newThumb = a.thumb_path?.replace(`${data.board.id}/${a.item_id}`, `${newBoardId}/${newItemId}`) || null;
      const newMedium = a.medium_path?.replace(`${data.board.id}/${a.item_id}`, `${newBoardId}/${newItemId}`) || null;
      stmt.insertAttachment.run({
        id: newId,
        board_id: newBoardId,
        item_id: newItemId,
        kind: a.kind,
        original_name: a.original_name,
        mime: a.mime,
        size: a.size,
        rel_path: newRel,
        thumb_path: newThumb,
        medium_path: newMedium,
        pos: a.pos,
        created_at: a.created_at || Date.now(),
      });
      // Extract physical file from zip and write to disk
      for (const [oldP, newP] of [[a.rel_path, newRel], [a.thumb_path, newThumb], [a.medium_path, newMedium]]) {
        if (!oldP || !newP) continue;
        const entry = zip.getEntry(`uploads/${oldP}`);
        if (entry) {
          const buf2 = entry.getData();
          const dir = dirname(join(UPLOAD_DIR, newP));
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          // sync write to keep inside transaction logically (small files ok)
          try { writeFileSync(join(UPLOAD_DIR, newP), buf2); } catch {}
        }
      }
    }
  });
  try {
    tx();
  } catch (e) {
    return c.json({ error: 'import failed: ' + e.message }, 500);
  }
  return c.json({ ok: true, id: newBoardId, name: newName });
});

// ===== Q&A =====
// List Q&A for an item
app.get('/api/boards/:id/items/:itemId/qa', (c) => {
  const rows = stmt.listQa.all(c.req.param('id'), c.req.param('itemId'));
  return c.json({ qa: rows });
});

// Ask a new question
// Body: { question, item, day_context, board_context, use_search }
app.post('/api/boards/:id/items/:itemId/qa', async (c) => {
  const boardId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const body = await c.req.json();
  const question = (body?.question || '').trim();
  if (!question) return c.json({ error: 'question required' }, 400);

  const useSearch = !!body?.use_search;
  const settings = boardSettingsObj(boardId);
  const preference = settings.preference || '';

  let content;
  try {
    content = await generateAnswer({
      question,
      item: body.item || {},
      city: body.city || '',
      day_summary: body.day_summary || '',
      board_name: body.board_name || '',
      preference,
      use_search: useSearch,
    });
  } catch (e) {
    return c.json({ error: 'LLM failed: ' + e.message }, 502);
  }
  if (!content) return c.json({ error: 'empty response' }, 502);

  const id = 'qa_' + randomBytes(8).toString('hex');
  stmt.insertQa.run(id, boardId, itemId, question, content, useSearch ? 'search' : 'llm', Date.now());
  return c.json({ id, question, answer: content, source: useSearch ? 'search' : 'llm', created_at: Date.now() });
});

app.delete('/api/qa/:id', (c) => {
  stmt.deleteQa.run(c.req.param('id'));
  return c.json({ ok: true });
});

app.delete('/api/boards/:id/items/:itemId/qa', (c) => {
  stmt.clearQaForItem.run(c.req.param('id'), c.req.param('itemId'));
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
