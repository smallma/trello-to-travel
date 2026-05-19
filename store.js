// store.js
// Talks to the backend API. Uses localStorage only for the password and a small
// metadata cache; full board payloads are fetched on demand.

const PW_KEY = 'trello-to-table.password';
const CACHE_KEY = 'trello-to-table.cache.v1';
const ACTIVE_KEY = 'trello-to-table.active';

const API_BASE = ''; // same-origin

// ---------- password ----------
export function getPassword() {
  return localStorage.getItem(PW_KEY) || '';
}
export function setPassword(pw) {
  localStorage.setItem(PW_KEY, pw);
}
export function clearPassword() {
  localStorage.removeItem(PW_KEY);
}

// ---------- generic fetch ----------
async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('X-API-Password', getPassword());
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(API_BASE + path, { ...init, headers });
  if (res.status === 401) {
    const err = new Error('密碼不正確');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.status === 204 ? null : await res.json();
}

export async function checkPassword() {
  await api('/api/auth/check', { method: 'POST' });
  return true;
}

export async function fetchConfig() {
  return await api('/api/config');
}

/**
 * Ask the backend for clean place names for a given day.
 * Backend uses MiniMax to normalize titles, with a cache + regex fallback.
 * @returns {Promise<{source: string, places: Array<{id,q}>}>}
 */
export async function fetchPlaces(boardId, dayDate, body, { refresh = false } = {}) {
  const path = `/api/boards/${encodeURIComponent(boardId)}/places/${encodeURIComponent(dayDate)}${refresh ? '?refresh=1' : ''}`;
  return await api(path, { method: 'POST', body: JSON.stringify(body) });
}

// ---------- AI guide ----------
export async function fetchGuide(boardId, itemId, body, { refresh = false } = {}) {
  const path = `/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}/guide${refresh ? '?refresh=1' : ''}`;
  return await api(path, { method: 'POST', body: JSON.stringify(body) });
}

// ---------- Hidden items ----------
export async function fetchHidden(boardId) {
  const { hidden } = await api(`/api/boards/${encodeURIComponent(boardId)}/hidden`);
  return new Set(hidden || []);
}
export async function setHidden(boardId, itemId, hidden) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/hidden`, {
    method: 'POST',
    body: JSON.stringify({ item_id: itemId, hidden }),
  });
}

// ---------- Board settings ----------
export async function fetchBoardSettings(boardId) {
  return await api(`/api/boards/${encodeURIComponent(boardId)}/settings`);
}
export async function saveBoardSettings(boardId, payload) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/settings`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}
export async function clearBoardCache(boardId) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/cache`, { method: 'DELETE' });
}

// ---------- Custom items + overrides ----------
export async function fetchExtras(boardId) {
  return await api(`/api/boards/${encodeURIComponent(boardId)}/extras`);
}
export async function createCustomItem(boardId, dayDate, payload) {
  return await api(`/api/boards/${encodeURIComponent(boardId)}/days/${encodeURIComponent(dayDate)}/items`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
export async function createDraft(boardId, dayDate) {
  return await api(`/api/boards/${encodeURIComponent(boardId)}/days/${encodeURIComponent(dayDate)}/draft`, {
    method: 'POST',
  });
}
export async function updateItem(boardId, itemId, payload) {
  return await api(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}
export async function deleteItem(boardId, itemId) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
}

// ---------- Geocode ----------
export async function geocode(q) {
  const path = `/api/geocode?q=${encodeURIComponent(q)}`;
  return await api(path);
}

// ---------- Reorder ----------
export async function saveDayOrder(boardId, dayDates) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/day-order`, {
    method: 'PUT', body: JSON.stringify({ day_dates: dayDates }),
  });
}
export async function saveItemOrder(boardId, dayDate, itemIds) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/days/${encodeURIComponent(dayDate)}/order`, {
    method: 'PUT', body: JSON.stringify({ item_ids: itemIds }),
  });
}

// ---------- Attachments ----------
export async function fetchAttachments(boardId) {
  const { attachments } = await api(`/api/boards/${encodeURIComponent(boardId)}/attachments`);
  return attachments || [];
}
export async function uploadAttachments(boardId, itemId, files) {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}/attachments`, {
    method: 'POST',
    headers: { 'X-API-Password': getPassword() },
    body: fd,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `upload ${res.status}`);
  }
  return await res.json();
}
export async function deleteAttachment(attachmentId) {
  await api(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
}
export async function setAttachmentCover(attachmentId) {
  await api(`/api/attachments/${encodeURIComponent(attachmentId)}/cover`, { method: 'POST' });
}
// URL helpers — embed password in query so <img>/<a download> work without headers
export function attachmentUrl(attachmentId, variant) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/${variant}?pw=${encodeURIComponent(getPassword())}`;
}

// ---------- Q&A ----------
export async function fetchQa(boardId, itemId) {
  const { qa } = await api(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}/qa`);
  return qa || [];
}
export async function askQa(boardId, itemId, payload) {
  return await api(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}/qa`, {
    method: 'POST', body: JSON.stringify(payload),
  });
}
export async function deleteQa(qaId) {
  await api(`/api/qa/${encodeURIComponent(qaId)}`, { method: 'DELETE' });
}
export async function clearQaForItem(boardId, itemId) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}/qa`, { method: 'DELETE' });
}

// ---------- Backup ----------
export function exportBoardUrl(boardId) {
  return `/api/boards/${encodeURIComponent(boardId)}/export?pw=${encodeURIComponent(getPassword())}`;
}
export async function importBoard(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/boards/import', {
    method: 'POST',
    headers: { 'X-API-Password': getPassword() },
    body: fd,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `import ${res.status}`);
  }
  return await res.json();
}

// ---------- boards ----------
export async function listBoards() {
  const { boards } = await api('/api/boards');
  return boards.map(b => ({
    id: b.id,
    name: b.name,
    importedAt: b.imported_at,
    updatedAt: b.updated_at,
  }));
}

export async function getBoard(id) {
  const data = await api(`/api/boards/${encodeURIComponent(id)}`);
  return { id: data.id, name: data.name, raw: data.raw, importedAt: data.imported_at };
}

export async function addBoard(raw) {
  const id = (raw.shortLink || raw.id || ('b_' + Date.now())) + '';
  await api(`/api/boards/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ raw }),
  });
  return { id, name: raw.name || '未命名行程' };
}

export async function deleteBoard(id) {
  await api(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---------- active board (per-account, synced across devices) ----------
export async function getActiveId() {
  try {
    const { active_board_id } = await api('/api/settings/active');
    return active_board_id;
  } catch {
    return localStorage.getItem(ACTIVE_KEY);
  }
}
export async function setActiveId(id) {
  localStorage.setItem(ACTIVE_KEY, id || '');
  try {
    await api('/api/settings/active', {
      method: 'PUT',
      body: JSON.stringify({ active_board_id: id || '' }),
    });
  } catch {}
}

// ---------- route off ----------
const routeOffCache = new Map(); // boardId -> { itemId: true }

export async function loadRouteOff(boardId) {
  if (!boardId) return {};
  try {
    const { route_off } = await api(`/api/boards/${encodeURIComponent(boardId)}/route-off`);
    routeOffCache.set(boardId, route_off || {});
    return route_off || {};
  } catch {
    return routeOffCache.get(boardId) || {};
  }
}

export function getRouteOff(boardId) {
  return routeOffCache.get(boardId) || {};
}

export async function setRouteOff(boardId, itemId, off) {
  const current = routeOffCache.get(boardId) || {};
  if (off) current[itemId] = true; else delete current[itemId];
  routeOffCache.set(boardId, current);
  try {
    await api(`/api/boards/${encodeURIComponent(boardId)}/route-off`, {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId, off }),
    });
  } catch (e) {
    console.warn('route-off sync failed:', e.message);
  }
}
