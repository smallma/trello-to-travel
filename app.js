// app.js
import { parseTrello } from './parser.js';
import { renderApp, renderDayMap, setRouteHandlers, resetPlacesCache } from './renderer.js';
import { toCopyJson } from './exporter.js';
import * as store from './store.js';
import { setMapsKey } from './maps.js';

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
  getHidden: () => hiddenIds,
  onHideItem: async (itemId) => {
    if (!activeBoardId) return;
    if (!confirm('要從顯示中隱藏這張卡片嗎？（可在設定頁還原）')) return;
    hiddenIds.add(itemId);
    try { await store.setHidden(activeBoardId, itemId, true); } catch (e) { showError(e.message); }
    document.querySelector(`.tl-card[data-item-id="${itemId}"]`)?.closest('.tl-row')?.remove();
  },
  isEditingRoute: () => editingRoute,
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
    currentData = data;
    await store.loadRouteOff(activeBoardId);
    try { hiddenIds = await store.fetchHidden(activeBoardId); } catch { hiddenIds = new Set(); }
    hideBanner();
    if (data.warnings.length) showWarning(data.warnings.join('；'));
    renderApp(data);
    toolbar.classList.remove('hidden');
  } catch (err) {
    showError(err.message || '解析失敗');
  }
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
  try {
    const cfg = await store.fetchConfig();
    setMapsKey(cfg.google_maps_key || '');
  } catch (e) {
    console.warn('fetchConfig failed:', e.message);
  }
  activeBoardId = await store.getActiveId();
  await refreshSidebar();
  await loadActiveBoard();
})();
