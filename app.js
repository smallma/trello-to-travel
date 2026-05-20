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
let customItems = [];
let overrides = {};
let isCustomId = new Set();
let attachmentsByItem = new Map();  // itemId -> [attachment, ...]
let serverFeatures = { llm: false, search: false, attachments: false, backup: false };

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
    await withLoading('刪除中…', async () => {
      try {
        await store.deleteItem(activeBoardId, itemId);
        await loadActiveBoard();
      } catch (e) { showError('刪除失敗：' + e.message); }
    });
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
  // Attachments
  getAttachmentsForItem: (itemId) => attachmentsByItem.get(itemId) || [],
  getAttachmentUrl: (id, variant) => store.attachmentUrl(id, variant),
  deleteAttachment: async (id) => {
    await store.deleteAttachment(id);
    // remove from cache
    for (const arr of attachmentsByItem.values()) {
      const i = arr.findIndex(a => a.id === id);
      if (i >= 0) arr.splice(i, 1);
    }
    await loadActiveBoard();
  },
  // Q&A
  fetchQa: (itemId) => store.fetchQa(activeBoardId, itemId),
  askQa: (itemId, payload) => store.askQa(activeBoardId, itemId, payload),
  deleteQa: (id) => store.deleteQa(id),
  getFeatures: () => serverFeatures,
  onAddDay: async (afterDate) => {
    if (!activeBoardId) return;
    const placeholder = afterDate ? '例：6/19 維也納' : '例：6/18 維也納';
    const listName = prompt('新增日（請輸入「M/D 標題」格式）', placeholder);
    if (!listName) return;
    await withLoading('新增日中…', async () => {
      try {
        await store.addDay(activeBoardId, listName.trim(), afterDate);
        await loadActiveBoard();
        showToast('已新增：' + listName);
      } catch (e) { showError('新增日失敗：' + e.message); }
    });
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
  await withLoading('讀取並匯入「' + file.name + '」…', async () => {
    try {
      const text = await file.text();
      let raw;
      try { raw = JSON.parse(text); } catch (err) { return showError('JSON 格式錯誤：' + err.message); }
      parseTrello(raw);
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
      if (b.id === activeBoardId) return;
      _currentDraftId = null;
      document.getElementById('item-modal')?.classList.add('hidden');
      document.getElementById('settings-modal')?.classList.add('hidden');
      activeBoardId = b.id;
      sidebar.classList.remove('open');
      await withLoading('切換到「' + b.name + '」…', async () => {
        try {
          await store.setActiveId(b.id);
          await refreshSidebar();
          await loadActiveBoard();
        } catch (err) {
          showError('載入失敗：' + err.message);
        }
      });
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
      await withLoading('刪除中…', async () => {
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
    try {
      const atts = await store.fetchAttachments(activeBoardId);
      attachmentsByItem = new Map();
      for (const a of atts) {
        if (!attachmentsByItem.has(a.item_id)) attachmentsByItem.set(a.item_id, []);
        attachmentsByItem.get(a.item_id).push(a);
      }
    } catch { attachmentsByItem = new Map(); }
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
    // Inject uploaded image attachments into item.images so they show as thumbs
    injectAttachmentImages(merged);
    currentData = merged;
    hideBanner();
    if (data.warnings.length) showWarning(data.warnings.join('；'));
    renderApp(merged);
    toolbar.classList.remove('hidden');
  } catch (err) {
    showError(err.message || '解析失敗');
  }
}

function injectAttachmentImages(merged) {
  const enrich = (item) => {
    const atts = attachmentsByItem.get(item.id);
    if (!atts || atts.length === 0) return item;
    const imgAtts = atts.filter(a => a.kind === 'image');
    if (imgAtts.length === 0) return item;
    const uploaded = imgAtts.map(a => ({
      thumb: store.attachmentUrl(a.id, 'thumb'),
      full: store.attachmentUrl(a.id, 'medium'),
      name: a.original_name,
    }));
    return { ...item, images: [...uploaded, ...(item.images || [])] };
  };
  for (const day of merged.days) day.items = day.items.map(enrich);
  for (const k of Object.keys(merged.extras)) merged.extras[k] = merged.extras[k].map(enrich);
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

// Sidebar "+ 新增" dropdown
const addBtn = document.getElementById('sidebar-add-btn');
const addMenu = document.getElementById('sidebar-add-menu');
const addBlank = document.getElementById('sidebar-add-blank');
if (addBtn && addMenu) {
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => addMenu.classList.add('hidden'));
}
if (addBlank) {
  addBlank.addEventListener('click', async (e) => {
    e.stopPropagation();
    addMenu.classList.add('hidden');
    const name = prompt('行程名稱', '我的新行程');
    if (!name) return;
    await withLoading('建立行程「' + name + '」…', async () => {
      try {
        const r = await store.createBlankBoard(name);
        activeBoardId = r.id;
        await store.setActiveId(r.id);
        await refreshSidebar();
        await loadActiveBoard();
        showToast('已建立：' + r.name);
      } catch (e2) {
        showError('建立失敗：' + e2.message);
      }
    });
  });
}

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

  const saveSettingsBtn = modal.querySelector('#st-save');
  saveSettingsBtn.onclick = async () => {
    await withBtnLoading(saveSettingsBtn, async () => {
      status.textContent = '';
      try {
        await store.saveBoardSettings(boardId, {
          name: nameInput.value.trim() || boardName,
          settings: { preference: prefInput.value.trim() },
        });
        status.textContent = '✓ 已儲存';
        await refreshSidebar();
        if (boardId === activeBoardId) await withLoading('套用變更…', () => loadActiveBoard());
      } catch (e) {
        status.textContent = '錯誤：' + e.message;
      }
    });
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
let _currentDraftId = null;   // tracks the draft created for an in-progress add

async function openItemEditor({ mode, item, day }) {
  const modal = document.getElementById('item-modal');
  modal.classList.remove('hidden');
  const f = modal.querySelector('#it-form');
  const title = modal.querySelector('#it-title');
  const status = modal.querySelector('#it-status');
  const h = modal.querySelector('#it-h');
  const dz = modal.querySelector('#it-dropzone');
  const dzStatus = modal.querySelector('#it-dz-status');
  const dzInput = dz.querySelector('input[type=file]');
  const attList = modal.querySelector('#it-attachments');

  h.textContent = mode === 'add' ? `+ 新增行程（${day?.list_name || ''}）` : '✏️ 編輯行程';

  let workingItem = item;
  if (mode === 'add') {
    showProgress();
    try {
      const r = await store.createDraft(activeBoardId, day.date);
      _currentDraftId = r.id;
      workingItem = { id: r.id, title: '', desc: '', category: { type: 'sight', emoji: '🏛️', label: '景點' }};
    } catch (e) {
      _currentDraftId = null;
      workingItem = { title: '', desc: '', category: { type: 'sight', emoji: '🏛️', label: '景點' }};
      status.textContent = '⚠ 建立草稿失敗，附件功能停用：' + e.message;
    } finally {
      hideProgress();
    }
  } else {
    _currentDraftId = null;
  }

  const it = workingItem;
  f.querySelector('#it-fld-title').value = it.title || '';
  f.querySelector('#it-fld-desc').value = it.desc || '';
  f.querySelector('#it-fld-place').value = it.place || '';
  f.querySelector('#it-fld-time-start').value = it.time_start || '';
  f.querySelector('#it-fld-time-end').value = it.time_end || '';
  // Show the saved category in the dropdown; if it's the legacy 'other'
  // (which we removed from the UI) or anything unknown, fall back to 'sight'.
  const KNOWN_TYPES = new Set(['sight','food','hotel','transit','shop','ticket']);
  f.querySelector('#it-fld-category').value = KNOWN_TYPES.has(it.category?.type) ? it.category.type : 'sight';
  f.querySelector('#it-fld-image').value = '';   // not used anymore; we upload via dropzone
  f.querySelector('#it-fld-links').value = (it.links || []).join('\n');
  status.textContent = '';
  title.textContent = it.title ? `（編輯：${it.title}）` : '';

  // Attachments: works for both edit (existing item) and add (just-created draft)
  const itemId = it.id || null;
  attList.innerHTML = '';
  if (itemId) {
    const refreshAttList = () => {
      attList.innerHTML = '';
      const atts = attachmentsByItem.get(itemId) || [];
      if (atts.length === 0) {
        attList.innerHTML = '<em class="muted">尚無附件</em>';
        return;
      }
      // First image in pos order is the cover
      const firstImageId = (atts.find(a => a.kind === 'image') || {}).id;
      for (const a of atts) {
        const row = document.createElement('div');
        row.className = 'attach-row';
        const isCover = a.id === firstImageId;
        if (a.kind === 'image') {
          row.innerHTML = `<img class="attach-thumb" src="${escapeAttr(store.attachmentUrl(a.id, 'thumb'))}" alt="">`;
        } else {
          row.innerHTML = `<span class="attach-icon">📄</span>`;
        }
        const coverTag = isCover ? `<span class="attach-cover-tag" title="目前的封面">⭐ 封面</span>` : '';
        row.insertAdjacentHTML('beforeend', `<span class="attach-name">${escapeHtml(a.original_name)}${coverTag}</span><span class="attach-size">${fmtBytes(a.size)}</span>`);

        // ⭐ Set-as-cover button (only for images, only when NOT already cover)
        if (a.kind === 'image' && !isCover) {
          const star = document.createElement('button');
          star.className = 'attach-cover-btn';
          star.textContent = '⭐';
          star.title = '設為封面';
          star.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
              await store.setAttachmentCover(a.id);
              // local re-order: move this att to the front
              const arr = attachmentsByItem.get(itemId);
              const i = arr.findIndex(x => x.id === a.id);
              if (i >= 0) {
                arr.splice(i, 1);
                arr.unshift(a);
              }
              refreshAttList();
            } catch (e2) { alert(e2.message); }
          });
          row.appendChild(star);
        }

        const del = document.createElement('button');
        del.className = 'attach-del'; del.textContent = '×'; del.title = '刪除';
        del.addEventListener('click', async (e) => {
          e.preventDefault();
          if (!confirm(`刪除「${a.original_name}」？`)) return;
          try {
            await store.deleteAttachment(a.id);
            const arr = attachmentsByItem.get(itemId);
            if (arr) {
              const i = arr.findIndex(x => x.id === a.id);
              if (i >= 0) arr.splice(i, 1);
            }
            refreshAttList();
          } catch (e2) { alert(e2.message); }
        });
        row.appendChild(del);
        attList.appendChild(row);
      }
    };
    refreshAttList();

    const doUpload = async (files) => {
      if (!files || files.length === 0) return;
      dz.classList.add('uploading');
      dzStatus.textContent = `上傳中… (${files.length} 個檔案)`;
      try {
        await store.uploadAttachments(activeBoardId, itemId, files);
        // re-fetch to get full DTOs
        const atts = await store.fetchAttachments(activeBoardId);
        attachmentsByItem = new Map();
        for (const a of atts) {
          if (!attachmentsByItem.has(a.item_id)) attachmentsByItem.set(a.item_id, []);
          attachmentsByItem.get(a.item_id).push(a);
        }
        refreshAttList();
        dzStatus.textContent = '✓ 上傳完成';
      } catch (e) {
        dzStatus.textContent = '⚠ ' + e.message;
      } finally {
        dz.classList.remove('uploading');
      }
    };

    dzInput.onchange = () => { doUpload(dzInput.files); dzInput.value = ''; };
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('dragover'); };
    dz.ondragleave = () => dz.classList.remove('dragover');
    dz.ondrop = (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      doUpload(e.dataTransfer.files);
    };
  } else {
    attList.innerHTML = '<em class="muted">先儲存卡片後才能上傳附件</em>';
    dz.style.display = 'none';
  }
  // Restore dropzone visibility when re-opening for edit
  if (itemId) dz.style.display = '';

  const saveBtn = modal.querySelector('#it-save');
  saveBtn.onclick = async () => {
    const payload = {
      title: f.querySelector('#it-fld-title').value.trim(),
      desc: f.querySelector('#it-fld-desc').value.trim(),
      place: f.querySelector('#it-fld-place').value.trim(),
      time_start: f.querySelector('#it-fld-time-start').value.trim(),
      time_end: f.querySelector('#it-fld-time-end').value.trim(),
      category: makeCategory(f.querySelector('#it-fld-category').value),
      links: f.querySelector('#it-fld-links').value.split('\n').map(s => s.trim()).filter(Boolean),
    };
    if (!payload.title) { status.textContent = '請輸入標題'; return; }
    status.textContent = '';
    await withBtnLoading(saveBtn, async () => {
      try {
        const targetId = mode === 'add' ? _currentDraftId : item.id;
        if (!targetId) throw new Error('沒有目標 ID');
        await store.updateItem(activeBoardId, targetId, payload);
        _currentDraftId = null;
        modal.classList.add('hidden');
        await withLoading('更新中…', () => loadActiveBoard());
      } catch (e) {
        status.textContent = '錯誤：' + e.message;
      }
    });
  };

  const discardDraftAndClose = async () => {
    // If there's an unsaved draft, ask before throwing away (incl. attachments)
    if (_currentDraftId) {
      const draftAtts = attachmentsByItem.get(_currentDraftId) || [];
      const draftId = _currentDraftId;
      const hasContent = (f.querySelector('#it-fld-title').value.trim() || draftAtts.length > 0);
      if (hasContent && !confirm(`未儲存的卡片會被刪除${draftAtts.length ? `（含 ${draftAtts.length} 個已上傳附件）` : ''}，確定取消？`)) {
        return;
      }
      _currentDraftId = null;
      try { await store.deleteItem(activeBoardId, draftId); } catch {}
    }
    modal.classList.add('hidden');
    // Refresh in case there were attachment uploads to a real card that got cancelled
    if (mode === 'edit') await loadActiveBoard();
  };
  modal.querySelector('#it-close').onclick = discardDraftAndClose;
}

document.getElementById('item-modal').addEventListener('click', (e) => {
  if (e.target.id === 'item-modal') {
    // Route through close button so draft cleanup runs
    document.getElementById('it-close').click();
  }
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

// ---------- Global loading helpers ----------
const _progress = document.getElementById('top-progress');
const _overlay = document.getElementById('loading-overlay');
const _overlayMsg = document.getElementById('loading-msg');
let _progressDepth = 0;
let _overlayDepth = 0;
function showProgress() { _progressDepth++; _progress.classList.remove('hidden'); }
function hideProgress() { _progressDepth = Math.max(0, _progressDepth - 1); if (_progressDepth === 0) _progress.classList.add('hidden'); }
function showLoading(msg = '載入中…') { _overlayDepth++; _overlayMsg.textContent = msg; _overlay.classList.remove('hidden'); }
function hideLoading() { _overlayDepth = Math.max(0, _overlayDepth - 1); if (_overlayDepth === 0) _overlay.classList.add('hidden'); }
async function withProgress(fn) { showProgress(); try { return await fn(); } finally { hideProgress(); } }
async function withLoading(msg, fn) { showLoading(msg); try { return await fn(); } finally { hideLoading(); } }
async function withBtnLoading(btn, fn) {
  if (!btn) return await fn();
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  try { return await fn(); }
  finally { btn.classList.remove('btn-loading'); btn.disabled = prevDisabled; }
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
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

// Export / import buttons
const exportBtn = document.getElementById('export-board');
if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    if (!activeBoardId) return showToast('沒有開啟的行程');
    showToast('準備下載 ZIP…');
    window.location.href = store.exportBoardUrl(activeBoardId);
  });
}
const importInput = document.getElementById('import-file');
if (importInput) {
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    await withLoading('匯入「' + file.name + '」… (' + fmtBytes(file.size) + ')', async () => {
      try {
        const res = await store.importBoard(file);
        showToast('已匯入：' + res.name);
        activeBoardId = res.id;
        await store.setActiveId(res.id);
        await refreshSidebar();
        await loadActiveBoard();
      } catch (e) {
        showError('匯入失敗：' + e.message);
      } finally {
        importInput.value = '';
      }
    });
  });
}

// ---------- Init ----------
(async function init() {
  if (!await ensureLoggedIn()) return;
  try {
    const cfg = await store.fetchConfig();
    serverFeatures = cfg.features || serverFeatures;
  } catch {}
  activeBoardId = await store.getActiveId();
  await refreshSidebar();
  await loadActiveBoard();
})();
