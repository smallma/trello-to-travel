// app.js
import { parseTrello } from './parser.js';
import { renderApp, renderDayMap, setRouteHandlers, resetPlacesCache } from './renderer.js';
import { toCopyJson } from './exporter.js';
import * as store from './store.js';

const fileInput = document.getElementById('file-input');
const toolbar = document.getElementById('toolbar');
const banner = document.getElementById('banner');
const toast = document.getElementById('toast');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');

let currentData = null;
let activeBoardId = null;
let hiddenIds = new Set();
let editingRoute = false;
let customItems = [];      // [{id, day_date, title, ...}]
let overrides = {};        // {trelloItemId: {title, desc, ...}}
let isCustomId = new Set();

setRouteHandlers({
  getRouteOff: () => activeBoardId ? store.getRouteOff(activeBoardId) : {},
  onToggle: async (itemId, off, day) => {
    if (!activeBoardId) return;
    await store.setRouteOff(activeBoardId, itemId, off);
    const block = document.querySelector(`[data-day-date="${day.date}"]`);
    const mapWrap = block && block.querySelector('[data-day-map]');
    if (mapWrap) renderDayMap(mapWrap, day);
  },
  fetchPlaces: (dayDate, body, opts) => store.fetchPlaces(activeBoardId, dayDate, body, opts),
  fetchGuide: (itemId, body, opts) => store.fetchGuide(activeBoardId, itemId, body, opts),
  geocode: (q) => store.geocode(q),
  getHidden: () => hiddenIds,
  isCustom: (id) => isCustomId.has(id),
  isEditingRoute: () => editingRoute,
  onHideItem: async (itemId) => {
    if (!activeBoardId) return;
    if (!confirm('要從顯示中隱藏這張卡片嗎？（可在設定頁還原）')) return;
    hiddenIds.add(itemId);
    try { await store.setHidden(activeBoardId, itemId, true); } catch (e) { showError(e.message); }
    document.querySelector(`.tl-card[data-item-id="${itemId}"]`)?.closest('.tl-row')?.remove();
  },
  onDeleteItem: async (itemId) => {
    if (!activeBoardId) return;
    if (!confirm('刪除這張自訂卡片？無法復原。')) return;
    try {
      await store.deleteItem(activeBoardId, itemId);
      await loadActiveBoard();
    } catch (e) { showError('刪除失敗：' + e.message); }
  },
  onEditItem: (item, day) => openItemEditor({ mode: 'edit', item, day }),
  onAddItem: (day) => openItemEditor({ mode: 'add', day }),
  onReorderItems: async (dayDate, itemIds) => {
    if (!activeBoardId) return;
    try {
      await store.saveItemOrder(activeBoardId, dayDate, itemIds);
      showToast('順序已儲存');
      // Re-render only the affected day's map (place inputs may have changed)
      resetPlacesCache();
      const block = document.querySelector(`[data-day-date="${dayDate}"]`);
      const mapWrap = block && block.querySelector('[data-day-map]');
      if (mapWrap && currentData) {
        const day = currentData.days.find(d => d.date === dayDate);
        if (day) renderDayMap(mapWrap, day);
      }
    } catch (e) { showError('儲存順序失敗：' + e.message); }
  },
  onReorderDays: async (dayDates) => {
    if (!activeBoardId) return;
    try {
      await store.saveDayOrder(activeBoardId, dayDates);
      showToast('天數順序已儲存');
    } catch (e) { showError('儲存天數順序失敗：' + e.message); }
  },
});

// ---------- Password gate ----------
async function ensureLoggedIn() {
  while (true) {
    if (!store.getPassword()) {
      const pw = prompt('🔒 請輸入 API 密碼\n（伺服器設定的密碼。第一次輸入後會記住，下次自動帶入。）');
      if (pw == null) return false;
      store.setPassword(pw);
    }
    try {
      await store.checkPassword();
      return true;
    } catch (e) {
      store.clearPassword();
      alert('密碼不正確，請再試一次。');
    }
  }
}

// ---------- File upload ----------
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
    return showError('請上傳合法的 JSON 檔（副檔名 .json）');
  }
  try {
    const text = await file.text();
    let raw;
    try { raw = JSON.parse(text); } catch (err) { return showError('JSON 格式錯誤：' + err.message); }
    parseTrello(raw); // validate
    const board = await store.addBoard(raw);
    activeBoardId = board.id;
    await store.setActiveId(board.id);
    await refreshSidebar();
    await loadActiveBoard();
    showToast('已匯入：' + board.name);
  } catch (err) {
    showError(err.message || '上傳失敗');
  } finally {
    fileInput.value = '';
  }
});

// ---------- Sidebar ----------
async function refreshSidebar() {
  let boards;
  try {
    boards = await store.listBoards();
  } catch (e) {
    showError('讀取行程清單失敗：' + e.message);
    return;
  }
  const list = document.getElementById('board-list');
  const empty = document.getElementById('sidebar-empty');
  list.innerHTML = '';
  if (boards.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  for (const b of boards) {
    const li = document.createElement('li');
    li.className = 'board-item' + (b.id === activeBoardId ? ' active' : '');
    li.innerHTML = `<span class="board-item-name" title="${escapeAttr(b.name)}">${escapeHtml(b.name)}</span>`;
    li.addEventListener('click', async (e) => {
      if (e.target.closest('.board-item-actions')) return;
      activeBoardId = b.id;
      await store.setActiveId(b.id);
      await refreshSidebar();
      await loadActiveBoard();
      sidebar.classList.remove('open');
    });
    const actions = document.createElement('div');
    actions.className = 'board-item-actions';

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'board-item-settings';
    settingsBtn.textContent = '⚙️';
    settingsBtn.title = '設定';
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.__openSettings(b.id, b.name);
    });
    actions.appendChild(settingsBtn);

    const del = document.createElement('button');
    del.className = 'board-item-delete';
    del.textContent = '×';
    del.title = '刪除這份行程';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`刪除「${b.name}」？此操作無法復原。`)) return;
      try {
        await store.deleteBoard(b.id);
        if (activeBoardId === b.id) {
          activeBoardId = null;
          await store.setActiveId('');
        }
        await refreshSidebar();
        await loadActiveBoard();
      } catch (err) {
        showError('刪除失敗：' + err.message);
      }
    });
    actions.appendChild(del);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

async function loadActiveBoard() {
  resetPlacesCache();
  if (!activeBoardId) {
    currentData = null;
    document.getElementById('trip-title').textContent = 'Trello → 旅行社行程表';
    document.getElementById('content').innerHTML = `
      <div class="empty-hint">
        <p class="text-lg">👈 從左側 <strong>+ 新增</strong> 上傳一份 Trello 匯出的 JSON</p>
        <p class="text-sm mt-2 text-gray-500">資料同步到你的後端，<strong>任何裝置登入都看得到</strong>。</p>
      </div>`;
    toolbar.classList.add('hidden');
    return;
  }
  try {
    const board = await store.getBoard(activeBoardId);
    const data = parseTrello(board.raw);
    await store.loadRouteOff(activeBoardId);
    try { hiddenIds = await store.fetchHidden(activeBoardId); } catch { hiddenIds = new Set(); }
    let itemOrder = {};
    let dayOrder = {};
    try {
      const extras = await store.fetchExtras(activeBoardId);
      customItems = extras.custom || [];
      overrides = extras.overrides || {};
      itemOrder = extras.item_order || {};
      dayOrder = extras.day_order || {};
    } catch {
      customItems = []; overrides = {};
    }
    isCustomId = new Set(customItems.map(c => c.id));

    // Merge + apply user-defined order (overrides Trello's pos)
    const merged = mergeBoardData(data, customItems, overrides, itemOrder, dayOrder);
    currentData = merged;
    hideBanner();
    if (data.warnings.length) showWarning(data.warnings.join('；'));
    renderApp(merged);
    toolbar.classList.remove('hidden');
  } catch (err) {
    showError(err.message || '解析失敗');
  }
}

function mergeBoardData(data, customs, overrides, itemOrder = {}, dayOrder = {}) {
  const applyOverride = (it) => {
    const ov = overrides[it.id];
    return ov ? { ...it, ...ov } : it;
  };

  // Collect ALL items (Trello + custom), tagged with their effective day_date.
  // If item_order has a row for that id, prefer its day_date (handles cross-day moves).
  const allItems = [];
  for (const day of data.days) {
    for (const it of day.items) {
      const ov = itemOrder[it.id];
      const dayDate = ov ? ov.day_date : day.date;
      allItems.push({ item: applyOverride(it), day_date: dayDate });
    }
  }
  for (const c of customs) {
    const ov = itemOrder[c.id];
    const dayDate = ov ? ov.day_date : c.day_date;
    allItems.push({ item: { ...c, _custom: true }, day_date: dayDate });
  }

  // Group items back per day
  const itemsByDay = new Map();
  for (const { item, day_date } of allItems) {
    if (!itemsByDay.has(day_date)) itemsByDay.set(day_date, []);
    itemsByDay.get(day_date).push(item);
  }

  // Sort each day's items by user_pos (or fall back to original Trello order)
  for (const [dayDate, items] of itemsByDay) {
    const trelloIndex = new Map();
    const original = data.days.find(d => d.date === dayDate);
    if (original) original.items.forEach((it, i) => trelloIndex.set(it.id, i));
    items.sort((a, b) => {
      const pa = itemOrder[a.id]?.pos ?? null;
      const pb = itemOrder[b.id]?.pos ?? null;
      if (pa != null && pb != null) return pa - pb;
      if (pa != null) return -1;
      if (pb != null) return 1;
      // Both no user pos: keep Trello order, custom items at end
      const ai = trelloIndex.has(a.id) ? trelloIndex.get(a.id) : 10000 + (a.pos ?? 0);
      const bi = trelloIndex.has(b.id) ? trelloIndex.get(b.id) : 10000 + (b.pos ?? 0);
      return ai - bi;
    });
  }

  // Build days array — keep every original day even if empty, plus any new day_date
  // introduced purely by drag (rare but possible).
  const dayDates = new Set(data.days.map(d => d.date));
  for (const dd of itemsByDay.keys()) dayDates.add(dd);
  const days = [...dayDates].map(date => {
    const original = data.days.find(d => d.date === date);
    return {
      list_name: original ? original.list_name : date,
      date,
      items: itemsByDay.get(date) || [],
    };
  });

  // Sort days: user dayOrder wins; fallback to original Trello order
  const trelloDayIndex = new Map();
  data.days.forEach((d, i) => trelloDayIndex.set(d.date, i));
  days.sort((a, b) => {
    const pa = dayOrder[a.date];
    const pb = dayOrder[b.date];
    if (pa != null && pb != null) return pa - pb;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return (trelloDayIndex.get(a.date) ?? 9999) - (trelloDayIndex.get(b.date) ?? 9999);
  });

  const extras = {};
  for (const [k, items] of Object.entries(data.extras)) {
    extras[k] = items.map(applyOverride);
  }
  return { ...data, days, extras };
}

// ---------- Toolbar ----------
document.getElementById('expand-all').addEventListener('click', () => {
  document.querySelectorAll('.tl-card').forEach(c => {
    const wasExpanded = c.classList.contains('expanded');
    c.classList.add('expanded');
    const tg = c.querySelector('.tl-toggle');
    if (tg) tg.textContent = '收合 ▴';
    if (!wasExpanded) c.dispatchEvent(new CustomEvent('cardExpanded'));
  });
  document.querySelectorAll('.day-block').forEach(c => c.classList.remove('collapsed'));
  document.querySelectorAll('.extras-group').forEach(c => c.classList.remove('collapsed'));
});

document.getElementById('collapse-all').addEventListener('click', () => {
  document.querySelectorAll('.tl-card').forEach(c => {
    c.classList.remove('expanded');
    const tg = c.querySelector('.tl-toggle');
    if (tg) tg.textContent = '展開更多 ▾';
  });
});

document.getElementById('copy-json').addEventListener('click', async () => {
  if (!currentData) return showToast('請先匯入 JSON');
  const includeExtras = document.getElementById('include-extras').checked;
  const text = toCopyJson(currentData, { includeExtras });
  const ok = await copyToClipboard(text);
  showToast(ok ? '已複製到剪貼簿' : '複製失敗，請改用 HTTPS 或手動複製');
});

sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

document.getElementById('reset-password').addEventListener('click', () => {
  store.clearPassword();
  location.reload();
});

// Edit-route toggle
const editRouteBtn = document.getElementById('edit-route-toggle');
if (editRouteBtn) {
  editRouteBtn.addEventListener('click', () => {
    editingRoute = !editingRoute;
    document.body.classList.toggle('editing-route', editingRoute);
    editRouteBtn.classList.toggle('active', editingRoute);
    editRouteBtn.textContent = editingRoute ? '✅ 編輯路線中' : '☑ 編輯路線';
  });
}

// Settings modal
async function openSettings(boardId, boardName) {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  const nameInput = modal.querySelector('#st-name');
  const prefInput = modal.querySelector('#st-pref');
  const hiddenList = modal.querySelector('#st-hidden-list');
  const status = modal.querySelector('#st-status');
  nameInput.value = boardName || '';
  prefInput.value = '';
  hiddenList.innerHTML = '<em>載入中…</em>';
  status.textContent = '';

  try {
    const s = await store.fetchBoardSettings(boardId);
    prefInput.value = s.preference || '';
  } catch {}

  try {
    const hidden = await store.fetchHidden(boardId);
    const board = await store.getBoard(boardId);
    const data = parseTrello(board.raw);
    const idToTitle = new Map();
    for (const day of data.days) for (const it of day.items) idToTitle.set(it.id, it.title);
    for (const items of Object.values(data.extras)) for (const it of items) idToTitle.set(it.id, it.title);

    if (hidden.size === 0) {
      hiddenList.innerHTML = '<em style="color:#9ca3af">沒有隱藏的卡片</em>';
    } else {
      hiddenList.innerHTML = '';
      for (const id of hidden) {
        const row = document.createElement('div');
        row.className = 'st-hidden-row';
        row.innerHTML = `<span>${escapeHtml(idToTitle.get(id) || id)}</span>`;
        const btn = document.createElement('button');
        btn.className = 'link-btn';
        btn.textContent = '還原';
        btn.addEventListener('click', async () => {
          await store.setHidden(boardId, id, false);
          row.remove();
          if (hiddenList.children.length === 0) hiddenList.innerHTML = '<em style="color:#9ca3af">沒有隱藏的卡片</em>';
          if (boardId === activeBoardId) {
            hiddenIds.delete(id);
            await loadActiveBoard();
          }
        });
        row.appendChild(btn);
        hiddenList.appendChild(row);
      }
    }
  } catch (e) {
    hiddenList.innerHTML = `<em style="color:#dc2626">${escapeHtml(e.message)}</em>`;
  }

  modal.querySelector('#st-save').onclick = async () => {
    status.textContent = '儲存中…';
    try {
      await store.saveBoardSettings(boardId, {
        name: nameInput.value.trim() || boardName,
        settings: { preference: prefInput.value.trim() },
      });
      status.textContent = '✓ 已儲存';
      // refresh sidebar in case name changed
      await refreshSidebar();
      if (boardId === activeBoardId) await loadActiveBoard();
    } catch (e) {
      status.textContent = '錯誤：' + e.message;
    }
  };

  modal.querySelector('#st-clear-cache').onclick = async () => {
    if (!confirm('清除這份行程的所有 AI 快取（地點與導遊）？\n下次顯示會重新呼叫 AI。')) return;
    status.textContent = '清除中…';
    try {
      await store.clearBoardCache(boardId);
      status.textContent = '✓ 已清除快取';
      if (boardId === activeBoardId) await loadActiveBoard();
    } catch (e) {
      status.textContent = '錯誤：' + e.message;
    }
  };

  modal.querySelector('#st-close').onclick = () => modal.classList.add('hidden');
}

// Click outside modal to close
document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') e.target.classList.add('hidden');
});

// Expose so sidebar can call it
window.__openSettings = openSettings;

// ---------- Item editor modal ----------
function openItemEditor({ mode, item, day }) {
  const modal = document.getElementById('item-modal');
  modal.classList.remove('hidden');
  const f = modal.querySelector('#it-form');
  const title = modal.querySelector('#it-title');
  const status = modal.querySelector('#it-status');
  const h = modal.querySelector('#it-h');

  h.textContent = mode === 'add' ? `+ 新增行程（${day?.list_name || ''}）` : '✏️ 編輯行程';

  const it = mode === 'edit' ? item : { title: '', desc: '', category: { type: 'other', emoji: '📌', label: '行程' }};
  f.querySelector('#it-fld-title').value = it.title || '';
  f.querySelector('#it-fld-desc').value = it.desc || '';
  f.querySelector('#it-fld-place').value = it.place || '';
  f.querySelector('#it-fld-time-start').value = it.time_start || '';
  f.querySelector('#it-fld-time-end').value = it.time_end || '';
  f.querySelector('#it-fld-category').value = it.category?.type || 'other';
  f.querySelector('#it-fld-image').value = (it.images && it.images[0]?.thumb) || '';
  f.querySelector('#it-fld-links').value = (it.links || []).join('\n');
  status.textContent = '';
  title.textContent = it.title ? `（編輯：${it.title}）` : '';

  modal.querySelector('#it-save').onclick = async () => {
    const payload = {
      title: f.querySelector('#it-fld-title').value.trim(),
      desc: f.querySelector('#it-fld-desc').value.trim(),
      place: f.querySelector('#it-fld-place').value.trim(),
      time_start: f.querySelector('#it-fld-time-start').value.trim(),
      time_end: f.querySelector('#it-fld-time-end').value.trim(),
      category: makeCategory(f.querySelector('#it-fld-category').value),
      links: f.querySelector('#it-fld-links').value.split('\n').map(s => s.trim()).filter(Boolean),
    };
    const img = f.querySelector('#it-fld-image').value.trim();
    if (img) payload.images = [{ thumb: img, full: img, name: '' }];

    if (!payload.title) {
      status.textContent = '請輸入標題';
      return;
    }
    status.textContent = '儲存中…';
    try {
      if (mode === 'add') {
        await store.createCustomItem(activeBoardId, day.date, payload);
      } else {
        await store.updateItem(activeBoardId, item.id, payload);
      }
      modal.classList.add('hidden');
      await loadActiveBoard();
    } catch (e) {
      status.textContent = '錯誤：' + e.message;
    }
  };

  modal.querySelector('#it-close').onclick = () => modal.classList.add('hidden');
}

document.getElementById('item-modal').addEventListener('click', (e) => {
  if (e.target.id === 'item-modal') e.target.classList.add('hidden');
});

const CATEGORY_DEFS = {
  food:    { emoji: '🍽️', label: '餐廳' },
  hotel:   { emoji: '🏨', label: '住宿' },
  transit: { emoji: '🚆', label: '交通' },
  shop:    { emoji: '🛍️', label: '購物' },
  ticket:  { emoji: '🎫', label: '票券' },
  sight:   { emoji: '🏛️', label: '景點' },
  other:   { emoji: '📌', label: '行程' },
};
function makeCategory(type) {
  return { type, ...(CATEGORY_DEFS[type] || CATEGORY_DEFS.other) };
}

// ---------- Helpers ----------
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function showError(msg) { banner.className = 'banner err'; banner.textContent = '⚠ ' + msg; }
function showWarning(msg) { banner.className = 'banner warn'; banner.textContent = '⚠ ' + msg; }
function hideBanner() { banner.className = 'banner hidden'; banner.textContent = ''; }

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- Init ----------
(async function init() {
  if (!await ensureLoggedIn()) return;
  activeBoardId = await store.getActiveId();
  await refreshSidebar();
  await loadActiveBoard();
})();
