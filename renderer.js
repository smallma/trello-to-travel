// renderer.js
// Vertical-timeline renderer with per-card route checkboxes and per-day Google Maps embed.

import { itemsToWaypoints, buildEmbedUrl, buildOpenUrl, hasMapsKey } from './maps.js';

const LABEL_COLORS = ['green','yellow','orange','red','purple','blue','sky','lime','pink','black'];

let onRouteToggleCb = null;
let getRouteOffCb = null;

export function setRouteHandlers({ onToggle, getRouteOff }) {
  onRouteToggleCb = onToggle;
  getRouteOffCb = getRouteOff;
}

export function renderApp(data) {
  document.getElementById('trip-title').textContent = data.trip;
  const main = document.getElementById('content');
  main.innerHTML = '';

  for (const day of data.days) {
    main.appendChild(renderDay(day));
  }

  if (Object.keys(data.extras).length > 0) {
    main.appendChild(renderExtras(data.extras));
  }
}

function renderDay(day) {
  const block = el('section', 'day-block');
  block.dataset.role = 'day';
  block.dataset.dayDate = day.date;

  const header = el('div', 'day-header');
  header.innerHTML = `<span>${escape(day.list_name)}</span><span class="chev">▾</span>`;
  header.addEventListener('click', () => block.classList.toggle('collapsed'));
  block.appendChild(header);

  const body = el('div', 'day-body');
  const timeline = el('div', 'timeline');
  for (const item of day.items) {
    timeline.appendChild(renderTimelineRow(item, day));
  }
  if (day.items.length === 0) {
    timeline.appendChild(el('div', 'timeline-empty', '（這天還沒有安排）'));
  }
  body.appendChild(timeline);

  // Map area
  const mapWrap = el('div', 'day-map');
  mapWrap.dataset.dayMap = day.date;
  renderDayMap(mapWrap, day);
  body.appendChild(mapWrap);

  block.appendChild(body);
  return block;
}

export function renderDayMap(wrap, day) {
  wrap.innerHTML = '';
  const routeOff = (getRouteOffCb && getRouteOffCb()) || {};
  const includedItems = day.items.filter(it => !routeOff[it.id]);
  const waypoints = itemsToWaypoints(includedItems);

  const header = el('div', 'day-map-header');
  if (waypoints.length === 0) {
    header.innerHTML = `<span><strong>🗺️ 路線</strong> · 沒有可定位的地點</span>`;
    wrap.appendChild(header);
    return;
  }
  if (waypoints.length === 1) {
    header.innerHTML = `<span><strong>🗺️ 路線</strong> · 只有一個地點，無法畫路線</span>`;
    const openUrl = buildOpenUrl(waypoints);
    if (openUrl) {
      const a = el('a', 'open-ext', '在 Google Maps 開啟 ↗');
      a.href = openUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      header.appendChild(a);
    }
    wrap.appendChild(header);
    return;
  }

  header.innerHTML = `<span><strong>🗺️ 路線</strong> · 共 ${waypoints.length} 個點（依時間軸順序，可勾選/取消）</span>`;
  const openUrl = buildOpenUrl(waypoints);
  if (openUrl) {
    const a = el('a', 'open-ext', '在 Google Maps 開啟 ↗');
    a.href = openUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    header.appendChild(a);
  }
  wrap.appendChild(header);

  if (!hasMapsKey()) {
    const note = el('div', 'day-map-empty', '⚠️ 後端未設定 Google Maps API key — 內嵌地圖暫不可用。點上方「在 Google Maps 開啟 ↗」仍可查看路線。');
    wrap.appendChild(note);
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.allowFullscreen = true;
  iframe.src = buildEmbedUrl(waypoints, 'driving');
  wrap.appendChild(iframe);
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

  // Route checkbox (only for items that can produce a waypoint)
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
  const hasDetail = item.desc || (item.labels && item.labels.length) || extraImages.length > 0;
  if (hasDetail) {
    const detail = el('div', 'tl-card-detail');
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
