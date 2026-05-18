// app.js
import { parseTrello } from './parser.js';
import { renderApp, renderDayMap, setRouteHandlers } from './renderer.js';
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

setRouteHandlers({
  getRouteOff: () => activeBoardId ? store.getRouteOff(activeBoardId) : {},
  onToggle: async (itemId, off, day) => {
    if (!activeBoardId) return;
    await store.setRouteOff(activeBoardId, itemId, off);
    const block = document.querySelector(`[data-day-date="${day.date}"]`);
    const mapWrap = block && block.querySelector('[data-day-map]');
    if (mapWrap) renderDayMap(mapWrap, day);
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
      if (e.target.classList.contains('board-item-delete')) return;
      activeBoardId = b.id;
      await store.setActiveId(b.id);
      await refreshSidebar();
      await loadActiveBoard();
      sidebar.classList.remove('open');
    });
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
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function loadActiveBoard() {
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
    c.classList.add('expanded');
    const tg = c.querySelector('.tl-toggle');
    if (tg) tg.textContent = '收合 ▴';
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
