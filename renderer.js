// renderer.js
// Vertical-timeline renderer with per-card route checkboxes and per-day Google Maps embed.

import { itemsToWaypoints, buildOpenUrl } from './maps.js';

const LABEL_COLORS = ['green','yellow','orange','red','purple','blue','sky','lime','pink','black'];

let onRouteToggleCb = null;
let getRouteOffCb = null;
let fetchPlacesCb = null;
let fetchGuideCb = null;
let onHideItemCb = null;
let onDeleteItemCb = null;
let onEditItemCb = null;
let onAddItemCb = null;
let isCustomCb = () => false;
let getHiddenCb = null;
let isEditingRouteCb = () => false;
let geocodeCb = null;
let onReorderItemsCb = null;
let onReorderDaysCb = null;
let getAttachmentsForItemCb = null;   // (itemId) => Array
let getAttachmentUrlCb = null;        // (id, variant) => string
let deleteAttachmentCb = null;        // (id) => Promise
let fetchQaCb = null;                 // (itemId) => Promise<Array>
let askQaCb = null;                   // (itemId, payload) => Promise<{id,question,answer,source,created_at}>
let deleteQaCb = null;                // (id) => Promise
let getFeaturesCb = () => ({});       // () => {llm, search}
const placesCache = new Map();

export function setRouteHandlers(opts) {
  onRouteToggleCb = opts.onToggle;
  getRouteOffCb = opts.getRouteOff;
  fetchPlacesCb = opts.fetchPlaces;
  fetchGuideCb = opts.fetchGuide;
  onHideItemCb = opts.onHideItem;
  onDeleteItemCb = opts.onDeleteItem;
  onEditItemCb = opts.onEditItem;
  onAddItemCb = opts.onAddItem;
  isCustomCb = opts.isCustom || (() => false);
  getHiddenCb = opts.getHidden;
  if (opts.isEditingRoute) isEditingRouteCb = opts.isEditingRoute;
  geocodeCb = opts.geocode;
  onReorderItemsCb = opts.onReorderItems;
  onReorderDaysCb = opts.onReorderDays;
  getAttachmentsForItemCb = opts.getAttachmentsForItem;
  getAttachmentUrlCb = opts.getAttachmentUrl;
  deleteAttachmentCb = opts.deleteAttachment;
  fetchQaCb = opts.fetchQa;
  askQaCb = opts.askQa;
  deleteQaCb = opts.deleteQa;
  if (opts.getFeatures) getFeaturesCb = opts.getFeatures;
}

export function resetPlacesCache() {
  placesCache.clear();
}

export function refreshEditRouteMode() {
  const editing = isEditingRouteCb();
  document.body.classList.toggle('editing-route', editing);
}

export function renderApp(data) {
  document.getElementById('trip-title').textContent = data.trip;
  const main = document.getElementById('content');
  main.innerHTML = '';

  const hidden = (getHiddenCb && getHiddenCb()) || new Set();

  for (const day of data.days) {
    const filteredDay = {
      ...day,
      items: day.items.filter(it => !hidden.has(it.id)),
    };
    main.appendChild(renderDay(filteredDay));
  }

  if (Object.keys(data.extras).length > 0) {
    const filteredExtras = {};
    for (const [k, items] of Object.entries(data.extras)) {
      filteredExtras[k] = items.filter(it => !hidden.has(it.id));
    }
    main.appendChild(renderExtras(filteredExtras));
  }

  refreshEditRouteMode();
  initDayDragging();
  initItemDragging();
}

function initDayDragging() {
  if (!onReorderDaysCb || typeof window.Sortable === 'undefined') return;
  const main = document.getElementById('content');
  if (!main || main._sortable) return;
  main._sortable = window.Sortable.create(main, {
    handle: '.day-drag-handle',
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: async () => {
      const days = [...main.querySelectorAll('.day-block')]
        .map(b => b.dataset.dayDate).filter(Boolean);
      if (days.length) onReorderDaysCb(days);
    },
  });
}

function initItemDragging() {
  if (!onReorderItemsCb || typeof window.Sortable === 'undefined') return;
  document.querySelectorAll('.timeline').forEach(tl => {
    if (tl._sortable) return;
    tl._sortable = window.Sortable.create(tl, {
      group: 'cards',
      handle: '.tl-drag-handle',
      draggable: '.tl-row',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onAdd: (evt) => onItemDropped(evt),
      onUpdate: (evt) => onItemDropped(evt),
    });
  });
}

function onItemDropped(evt) {
  const toDayDate = evt.to.closest('.day-block')?.dataset.dayDate;
  if (!toDayDate) return;
  const itemIds = [...evt.to.querySelectorAll('.tl-row .tl-card')]
    .map(c => c.dataset.itemId).filter(Boolean);
  onReorderItemsCb(toDayDate, itemIds);
}

function renderDay(day) {
  const block = el('section', 'day-block');
  block.dataset.role = 'day';
  block.dataset.dayDate = day.date;

  const header = el('div', 'day-header');
  header.innerHTML = `<span class="day-drag-handle" title="拖曳調換整天順序">⋮⋮</span><span class="day-name">${escape(day.list_name)}</span><span class="chev">▾</span>`;
  header.addEventListener('click', (e) => {
    if (e.target.classList.contains('day-drag-handle')) return;
    block.classList.toggle('collapsed');
  });
  header.querySelector('.day-drag-handle').addEventListener('click', e => e.stopPropagation());
  block.appendChild(header);

  const body = el('div', 'day-body');

  // + 新增 button (per-day)
  if (onAddItemCb) {
    const addBar = el('div', 'day-add-bar');
    const addBtn = el('button', 'day-add-btn', '+ 新增行程');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onAddItemCb(day);
    });
    addBar.appendChild(addBtn);
    body.appendChild(addBar);
  }

  const timeline = el('div', 'timeline');
  for (const item of day.items) {
    timeline.appendChild(renderTimelineRow(item, day));
  }
  if (day.items.length === 0) {
    timeline.appendChild(el('div', 'timeline-empty', '（這天還沒有安排）'));
  }
  body.appendChild(timeline);

  // Map area (async; loading state handled inside)
  const mapWrap = el('div', 'day-map');
  mapWrap.dataset.dayMap = day.date;
  body.appendChild(mapWrap);
  renderDayMap(mapWrap, day);

  block.appendChild(body);
  return block;
}

export async function renderDayMap(wrap, day, { refresh = false } = {}) {
  wrap.innerHTML = '';
  const loading = el('div', 'day-map-header', '');
  loading.innerHTML = `<span><strong>🗺️ 路線</strong> · ⏳ 解析地點中…</span>`;
  wrap.appendChild(loading);

  // Step 1: ask backend for clean place strings (LLM + cache + fallback)
  let resolved;
  try {
    if (!fetchPlacesCb) throw new Error('fetchPlaces not configured');
    if (!refresh && placesCache.has(day.date)) {
      resolved = placesCache.get(day.date);
    } else {
      const city = extractCity(day.list_name);
      resolved = await fetchPlacesCb(day.date, {
        city,
        items: day.items.map(it => ({ id: it.id, title: it.title, place: it.place })),
      }, { refresh });
      placesCache.set(day.date, resolved);
    }
  } catch (e) {
    console.warn('[map] fetchPlaces failed, using local regex:', e.message);
    resolved = { source: 'local', places: itemsToWaypoints(day.items, day.list_name) };
  }

  const routeOff = (getRouteOffCb && getRouteOffCb()) || {};
  const allWp = resolved.places || [];
  const waypoints = allWp.filter(w => !routeOff[w.id]);

  wrap.innerHTML = '';
  const header = el('div', 'day-map-header');
  const sourceLabel = sourceBadge(resolved.source);

  if (waypoints.length === 0) {
    header.innerHTML = `<span><strong>🗺️ 路線</strong> · 沒有可定位的地點 ${sourceLabel}</span>`;
    appendRefreshBtn(header, wrap, day);
    wrap.appendChild(header);
    return;
  }

  header.innerHTML = `<span><strong>🗺️ 路線</strong> · 共 ${waypoints.length} 個點（地圖點對應時間軸順序） ${sourceLabel}</span>`;
  const openUrl = buildOpenUrl(waypoints);
  if (openUrl) appendOpenLink(header, openUrl);
  appendRefreshBtn(header, wrap, day);
  wrap.appendChild(header);

  // List of places (above map) — click jumps to marker
  const listWrap = el('div', 'day-map-list');
  wrap.appendChild(listWrap);

  // Map div
  const mapDiv = el('div', 'leaflet-map');
  mapDiv.style.height = '360px';
  wrap.appendChild(mapDiv);

  const map = L.map(mapDiv, { scrollWheelZoom: false }).setView([20, 0], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Geocode all waypoints in parallel (backend rate-limits Nominatim)
  const coords = [];
  await Promise.all(waypoints.map(async (wp, i) => {
    try {
      const g = await geocodeCb(wp.q);
      if (g && g.lat != null && g.lng != null) {
        coords[i] = { lat: g.lat, lng: g.lng, label: wp.q };
      }
    } catch {}
  }));

  const markers = [];
  const validCoords = [];
  coords.forEach((c, i) => {
    if (!c) return;
    validCoords.push(c);
    const marker = L.marker([c.lat, c.lng], { icon: numberedIcon(i + 1) }).addTo(map);
    marker.bindPopup(`<strong>${i + 1}.</strong> ${escape(c.label)}`);
    markers[i] = marker;
  });

  if (validCoords.length === 0) {
    mapDiv.style.display = 'none';
    listWrap.style.display = 'none';
    wrap.appendChild(el('div', 'day-map-empty', '⚠️ 沒有任何地點可以定位（OSM Nominatim 查不到）。請點上方「在 Google Maps 開啟 ↗」'));
    return;
  }

  L.polyline(validCoords.map(c => [c.lat, c.lng]), {
    color: '#2D5A4E', weight: 2.5, opacity: 0.7, dashArray: '6 8',
  }).addTo(map);

  const group = L.featureGroup(validCoords.filter(Boolean).map(c => L.marker([c.lat, c.lng])));
  map.fitBounds(group.getBounds(), { padding: [30, 30] });

  // Build clickable list
  coords.forEach((c, i) => {
    const chip = el('button', 'day-map-chip' + (c ? '' : ' off'));
    chip.innerHTML = `<span class="day-map-chip-num">${i + 1}</span><span class="day-map-chip-label">${escape(waypoints[i].q)}</span>`;
    if (c && markers[i]) {
      chip.title = '點擊放大此地點';
      chip.addEventListener('click', () => {
        map.flyTo([c.lat, c.lng], 16, { duration: 0.6 });
        markers[i].openPopup();
        mapDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } else {
      chip.title = '無法定位';
      chip.disabled = true;
    }
    listWrap.appendChild(chip);
  });
}

function numberedIcon(n) {
  return L.divIcon({
    className: 'tl-marker',
    html: `<div class="tl-marker-pin"><span>${n}</span></div>`,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -32],
  });
}

function buildQaSection(item, day) {
  const features = getFeaturesCb();
  const qa = el('div', 'tl-qa');
  qa.innerHTML = `
    <div class="tl-qa-header">
      <span>💬 <strong>問問題</strong></span>
    </div>
    <form class="tl-qa-form">
      <input class="tl-qa-input" placeholder="問這個景點任何問題…">
      <button type="button" class="tl-qa-ask" data-mode="llm">一般回覆</button>
      <button type="button" class="tl-qa-ask tl-qa-ask-search" data-mode="search" ${features.search ? '' : 'disabled title="後端未設定 TAVILY_API_KEY"'}>✨ 最新資訊</button>
    </form>
    <div class="tl-qa-list"></div>
  `;
  const input = qa.querySelector('.tl-qa-input');
  const list = qa.querySelector('.tl-qa-list');
  let loaded = false;

  const renderQa = (rows) => {
    list.innerHTML = '';
    for (const row of rows) {
      list.appendChild(renderQaRow(row));
    }
  };

  const renderQaRow = (row) => {
    const r = el('div', 'tl-qa-row');
    const sourceTag = row.source === 'search' ? '<span class="tl-qa-source">🌐 含最新搜尋</span>' : '';
    r.innerHTML = `
      <div class="tl-qa-q"><strong>Q:</strong> ${escape(row.question)} ${sourceTag}</div>
      <div class="tl-qa-a"></div>
      <button class="tl-qa-del" title="刪除這則問答">×</button>
    `;
    r.querySelector('.tl-qa-a').innerHTML = window.marked.parse(row.answer || '');
    r.querySelector('.tl-qa-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('刪除這則問答？')) return;
      try { await deleteQaCb(row.id); r.remove(); } catch (e2) { alert('刪除失敗：' + e2.message); }
    });
    return r;
  };

  const loadList = async () => {
    if (loaded) return;
    try {
      const rows = await fetchQaCb(item.id);
      renderQa(rows);
      loaded = true;
    } catch {}
  };

  const ask = async (useSearch) => {
    const q = input.value.trim();
    if (!q) {
      input.focus();
      input.placeholder = '請先輸入問題再點按鈕';
      setTimeout(() => { input.placeholder = '問這個景點任何問題…'; }, 1500);
      return;
    }
    input.disabled = true;
    qa.querySelectorAll('.tl-qa-ask').forEach(b => b.disabled = true);
    const tmp = el('div', 'tl-qa-row');
    tmp.innerHTML = `<div class="tl-qa-q"><strong>Q:</strong> ${escape(q)} ${useSearch ? '<span class="tl-qa-source">🌐 搜尋中…</span>' : ''}</div><div class="tl-qa-a"><em class="muted">⏳ AI 思考中（最多 60 秒）…</em></div>`;
    list.insertBefore(tmp, list.firstChild);
    try {
      const daySummary = day ? day.items.map(it => {
        const t = it.time_start ? `${it.time_start} ` : '';
        return `- ${t}${it.title}`;
      }).join('\n') : '';
      const res = await askQaCb(item.id, {
        question: q,
        item: { id: item.id, title: item.title, category: item.category, place: item.place, desc: item.desc },
        city: day ? extractCity(day.list_name) : '',
        day_summary: daySummary,
        board_name: document.getElementById('trip-title')?.textContent || '',
        use_search: useSearch,
      });
      tmp.replaceWith(renderQaRow(res));
      input.value = '';
    } catch (e) {
      tmp.querySelector('.tl-qa-a').innerHTML = `<em class="muted" style="color:#dc2626">⚠️ ${escape(e.message)}</em>`;
    } finally {
      input.disabled = false;
      qa.querySelectorAll('.tl-qa-ask').forEach(b => {
        // restore disabled state — search button stays disabled if feature off
        const features = getFeaturesCb();
        if (b.classList.contains('tl-qa-ask-search') && !features.search) {
          b.disabled = true;
        } else {
          b.disabled = false;
        }
      });
      input.focus();
    }
  };

  qa.querySelectorAll('.tl-qa-ask').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      ask(btn.dataset.mode === 'search');
    });
  });
  // declared 'card' lives in the enclosing renderTimelineRow scope; we don't have direct
  // access here, but cardExpanded bubbles up — listen on the QA element itself when it's
  // appended into the card. Instead we hook into the closest .tl-card after mount via
  // setTimeout so the parent attaches first.
  setTimeout(() => {
    const owner = qa.closest('.tl-card');
    if (owner) owner.addEventListener('cardExpanded', loadList);
  }, 0);

  return qa;
}

function buildFileAttachments(atts) {
  const wrap = el('div', 'tl-files');
  wrap.innerHTML = '<div class="tl-files-h">📎 附件</div>';
  for (const a of atts) {
    const row = el('div', 'tl-file-row');
    const url = getAttachmentUrlCb(a.id, 'original');
    row.innerHTML = `
      <a class="tl-file-name" href="${escape(url)}" download="${escape(a.original_name)}">${fileIcon(a.mime)} ${escape(a.original_name)}</a>
      <span class="tl-file-size">${fmtSize(a.size)}</span>
      <button class="tl-file-del" title="刪除">×</button>
    `;
    row.querySelector('.tl-file-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`刪除附件「${a.original_name}」？`)) return;
      try { await deleteAttachmentCb(a.id); } catch (e2) { alert(e2.message); }
    });
    wrap.appendChild(row);
  }
  return wrap;
}

function fileIcon(mime) {
  if (!mime) return '📄';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('word') || mime.includes('document')) return '📘';
  if (mime.includes('sheet') || mime.includes('excel')) return '📗';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.includes('zip') || mime.includes('compressed')) return '🗜️';
  return '📄';
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function appendOpenLink(header, url) {
  const a = el('a', 'open-ext', '在 Google Maps 開啟 ↗');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  header.appendChild(a);
}

function appendRefreshBtn(header, wrap, day) {
  const btn = el('button', 'map-refresh', '↻ 重新分析');
  btn.title = '強制請 AI 重新整理這天的地點';
  btn.addEventListener('click', () => {
    placesCache.delete(day.date);
    renderDayMap(wrap, day, { refresh: true });
  });
  header.appendChild(btn);
}

function sourceBadge(source) {
  if (source === 'llm') return '<small style="color:#9ca3af">· 🤖 AI</small>';
  if (source === 'cache') return '<small style="color:#9ca3af">· 🤖 AI (cached)</small>';
  if (source === 'fallback' || source === 'cache_fallback' || source === 'local')
    return '<small style="color:#9ca3af">· 規則式</small>';
  return '';
}

function extractCity(listName) {
  if (!listName) return '';
  const s = listName.replace(/^\s*\d+\/\d+\s*/, '').replace(/\([^)]*\)/g, '').trim();
  const m = s.match(/[一-鿿]{2,}/);
  return m ? m[0] : '';
}

function renderTimelineRow(item, day) {
  const hasTime = !!item.time_start;
  const row = el('div', 'tl-row' + (hasTime ? '' : ' tl-row-notime'));

  const timeCol = el('div', 'tl-time');
  if (hasTime) {
    timeCol.appendChild(el('div', 'tl-time-start', item.time_start));
    if (item.time_end) timeCol.appendChild(el('div', 'tl-time-end', '– ' + item.time_end));
  }
  row.appendChild(timeCol);

  const dot = el('div', 'tl-dot tl-dot-' + (item.category?.type || 'other'));
  row.appendChild(dot);

  const card = el('div', 'tl-card');
  card.dataset.itemId = item.id;

  // Drag handle (left edge)
  if (onReorderItemsCb) {
    const dh = el('span', 'tl-drag-handle', '⋮⋮');
    dh.title = '拖曳調整順序（可跨日）';
    dh.addEventListener('click', e => e.stopPropagation());
    card.appendChild(dh);
  }

  // Route checkbox — only shown when body has class "editing-route"
  const canRoute = !!((item.place && item.place.trim()) || item.title);
  if (canRoute && day) {
    const routeOff = (getRouteOffCb && getRouteOffCb()) || {};
    const checked = !routeOff[item.id];
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tl-card-check';
    cb.checked = checked;
    cb.title = '加入此日地圖路線';
    if (!checked) card.classList.add('route-off');
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      const off = !cb.checked;
      card.classList.toggle('route-off', off);
      if (onRouteToggleCb) onRouteToggleCb(item.id, off, day);
    });
    card.appendChild(cb);
  }

  // Hover-only action buttons (top-right)
  const actions = el('div', 'tl-card-actions');
  if (onEditItemCb) {
    const editBtn = el('button', 'tl-card-action', '✏️');
    editBtn.title = '編輯';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onEditItemCb(item, day);
    });
    actions.appendChild(editBtn);
  }
  const isCustom = isCustomCb(item.id);
  if (isCustom && onDeleteItemCb) {
    const delBtn = el('button', 'tl-card-action tl-card-delete', '🗑');
    delBtn.title = '刪除這張自訂卡片';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDeleteItemCb(item.id);
    });
    actions.appendChild(delBtn);
  } else if (onHideItemCb) {
    const hideBtn = el('button', 'tl-card-action', '×');
    hideBtn.title = '從顯示中隱藏（可從設定還原）';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onHideItemCb(item.id);
    });
    actions.appendChild(hideBtn);
  }
  card.appendChild(actions);

  const cardInner = el('div', 'tl-card-inner');
  if (item.images && item.images.length) {
    cardInner.classList.add('has-thumb');
    const thumbWrap = el('div', 'tl-thumb-wrap');
    const thumb = el('img', 'tl-thumb');
    thumb.src = item.images[0].thumb;
    thumb.alt = item.title;
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    thumb.addEventListener('error', () => {
      thumbWrap.classList.add('tl-thumb-failed');
      thumbWrap.innerHTML = '<span>📷</span><small>需登入 Trello</small>';
    });
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(item.images[0].full || item.images[0].thumb);
    });
    thumbWrap.appendChild(thumb);
    if (item.images.length > 1) {
      thumbWrap.appendChild(el('span', 'tl-thumb-count', '+' + (item.images.length - 1)));
    }
    cardInner.appendChild(thumbWrap);
  }

  const cardMain = el('div', 'tl-card-main');

  const head = el('div', 'tl-card-head');
  const badge = el('span', 'tl-badge tl-badge-' + (item.category?.type || 'other'),
    `${item.category?.emoji || '📌'} ${item.category?.label || '行程'}`);
  head.appendChild(badge);
  head.appendChild(el('span', 'tl-card-title', item.title));
  cardMain.appendChild(head);

  const subParts = [];
  if (item.place) subParts.push('📍 ' + item.place);
  const preview = previewText(item.desc);
  if (preview) subParts.push(preview);
  if (subParts.length) {
    cardMain.appendChild(el('div', 'tl-card-sub', subParts.join(' · ')));
  }

  if (item.links && item.links.length) {
    const linkRow = el('div', 'tl-card-links');
    for (const url of item.links) {
      const a = el('a', 'tl-link-btn', '🔗 查看資訊');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = url;
      linkRow.appendChild(a);
    }
    cardMain.appendChild(linkRow);
  }

  cardInner.appendChild(cardMain);
  card.appendChild(cardInner);

  const extraImages = (item.images && item.images.length > 1) ? item.images.slice(1) : [];
  const guideEnabled = !!fetchGuideCb;
  const hasDetail = item.desc || (item.labels && item.labels.length) || extraImages.length > 0 || guideEnabled;
  if (hasDetail) {
    const detail = el('div', 'tl-card-detail');

    // AI guide block (lazy)
    if (guideEnabled) {
      const features = getFeaturesCb();
      const searchBtn = features.search
        ? `<button class="tl-guide-search" title="用網路搜尋最新資訊重寫">✨ 搜尋最新</button>`
        : `<button class="tl-guide-search" disabled title="後端未設定 TAVILY_API_KEY">✨ 搜尋最新</button>`;
      const guideBox = el('div', 'tl-guide');
      guideBox.innerHTML = `
        <div class="tl-guide-header">
          <span>🎙️ <strong>AI 導遊</strong></span>
          <span class="tl-guide-actions">
            <button class="tl-guide-refresh" title="MiniMax 重新生成">↻</button>
            ${searchBtn}
          </span>
        </div>
        <div class="tl-guide-body"><em class="muted">點「展開更多」首次載入…</em></div>
        <div class="tl-guide-warning">⚠️ AI 回答僅供參考，行前請查當地官網確認</div>
      `;
      const refreshBtn = guideBox.querySelector('.tl-guide-refresh');
      const searchBtnEl = guideBox.querySelector('.tl-guide-search');
      const bodyEl = guideBox.querySelector('.tl-guide-body');
      let loaded = false;
      const loadGuide = async ({ refresh = false, search = false } = {}) => {
        bodyEl.innerHTML = '<em class="muted">⏳ AI 撰寫中（最多 60 秒）…</em>';
        try {
          const city = day ? extractCity(day.list_name) : '';
          const res = await fetchGuideCb(item.id, {
            item: { id: item.id, title: item.title, category: item.category, place: item.place, desc: item.desc },
            city,
          }, { refresh, search });
          bodyEl.innerHTML = window.marked.parse(res.content || '');
          const tag = res.source === 'cache' ? '🤖 快取' : (res.source === 'search' ? '🌐 含最新搜尋' : '🤖 AI');
          bodyEl.appendChild(Object.assign(document.createElement('div'), {
            className: 'tl-guide-meta',
            textContent: '— ' + tag,
          }));
          loaded = true;
        } catch (e) {
          bodyEl.innerHTML = `<em class="muted">⚠️ 載入失敗：${escape(e.message)}</em>`;
        }
      };
      refreshBtn.addEventListener('click', e => { e.stopPropagation(); loadGuide({ refresh: true }); });
      searchBtnEl.addEventListener('click', e => {
        e.stopPropagation();
        if (searchBtnEl.disabled) return;
        loadGuide({ refresh: true, search: true });
      });
      const trigger = () => { if (!loaded) loadGuide(); };
      card.addEventListener('cardExpanded', trigger, { once: false });
      detail.appendChild(guideBox);

      // Q&A
      if (fetchQaCb) {
        detail.appendChild(buildQaSection(item, day));
      }
    }

    // Uploaded file attachments (non-image)
    const fileAtts = (getAttachmentsForItemCb?.(item.id) || []).filter(a => a.kind !== 'image');
    if (fileAtts.length) {
      detail.appendChild(buildFileAttachments(fileAtts));
    }

    if (item.desc) {
      const md = el('div', 'markdown');
      md.innerHTML = window.marked.parse(stripBareUrls(item.desc));
      detail.appendChild(md);
    }
    if (extraImages.length) {
      const gallery = el('div', 'tl-gallery');
      for (const img of extraImages) {
        const im = el('img', 'tl-gallery-thumb');
        im.src = img.thumb;
        im.alt = item.title;
        im.loading = 'lazy';
        im.referrerPolicy = 'no-referrer';
        im.addEventListener('error', () => {
          im.replaceWith(Object.assign(document.createElement('span'), {
            className: 'tl-gallery-fail',
            textContent: '📷',
          }));
        });
        im.addEventListener('click', (e) => {
          e.stopPropagation();
          openLightbox(img.full || img.thumb);
        });
        gallery.appendChild(im);
      }
      detail.appendChild(gallery);
    }
    if (item.labels && item.labels.length) {
      const labelRow = el('div', 'tl-labels');
      labelRow.innerHTML = item.labels.map(l => {
        const color = LABEL_COLORS.includes(l.color) ? l.color : 'black';
        return `<span class="label-chip label-${color}">${escape(l.name || color)}</span>`;
      }).join('');
      detail.appendChild(labelRow);
    }
    card.appendChild(detail);

    const toggle = el('button', 'tl-toggle', '展開更多 ▾');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = card.classList.toggle('expanded');
      toggle.textContent = expanded ? '收合 ▴' : '展開更多 ▾';
      if (expanded) card.dispatchEvent(new CustomEvent('cardExpanded'));
    });
    card.appendChild(toggle);
  }

  row.appendChild(card);
  return row;
}

function openLightbox(url) {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = el('div', '', '');
    lb.id = 'lightbox';
    lb.innerHTML = '<img alt="">';
    lb.addEventListener('click', () => lb.classList.remove('open'));
    document.body.appendChild(lb);
  }
  lb.querySelector('img').src = url;
  lb.classList.add('open');
}

function renderExtras(extras) {
  const wrap = el('section', 'extras-section');
  wrap.appendChild(el('h2', '', '📌 補充資訊'));

  for (const [name, items] of Object.entries(extras)) {
    const group = el('div', 'extras-group collapsed');
    const header = el('div', 'extras-group-header');
    header.innerHTML = `<span>${escape(name)}（${items.length}）</span><span class="chev">▾</span>`;
    header.addEventListener('click', () => group.classList.toggle('collapsed'));
    group.appendChild(header);

    const body = el('div', 'extras-group-body');
    const tl = el('div', 'timeline');
    for (const item of items) {
      tl.appendChild(renderTimelineRow(item, null));
    }
    if (items.length === 0) {
      tl.appendChild(el('div', 'timeline-empty', '（沒有項目）'));
    }
    body.appendChild(tl);
    group.appendChild(body);

    wrap.appendChild(group);
  }
  return wrap;
}

function previewText(desc) {
  if (!desc) return '';
  const firstLine = desc
    .split('\n')
    .map(s => s.trim())
    .find(s => s.length > 0 && !/^https?:\/\//.test(s)) || '';
  const clean = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
}

function stripBareUrls(md) {
  return md.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (/^\[?https?:\/\/\S+\]?(\(https?:\/\/\S+\))?$/.test(t)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
