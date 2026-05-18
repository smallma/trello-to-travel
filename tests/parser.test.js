import { parseTrello } from '../parser.js';

group('parseTrello — 基本驗證');

test('丟非物件會 throw', () => {
  let err;
  try { parseTrello(null); } catch (e) { err = e; }
  assert(err, 'should throw');
  assert(err.message.includes('Trello'), 'error message should mention Trello');
});

test('缺 cards 或 lists 會 throw', () => {
  let err;
  try { parseTrello({ name: 'x' }); } catch (e) { err = e; }
  assert(err);
});

test('回傳結構含 trip / days / extras / warnings', () => {
  const result = parseTrello({
    name: '測試行程',
    cards: [],
    lists: [],
  });
  assert(result.trip === '測試行程');
  assert(Array.isArray(result.days));
  assert(typeof result.extras === 'object');
  assert(Array.isArray(result.warnings));
});

group('parseTrello — 分類與排序');

test('日期清單依月日排序', () => {
  const result = parseTrello({
    name: 't',
    lists: [
      { id: 'l2', name: '6/20威尼斯', closed: false, pos: 100 },
      { id: 'l1', name: '6/18 (四) 維也納', closed: false, pos: 200 },
      { id: 'l3', name: '7/1 (三) 回台', closed: false, pos: 50 },
    ],
    cards: [],
  });
  assertEq(result.days.map(d => d.date), ['6/18', '6/20', '7/1']);
});

test('過濾 closed 清單', () => {
  const result = parseTrello({
    name: 't',
    lists: [
      { id: 'l1', name: '6/18 開放', closed: false, pos: 1 },
      { id: 'l2', name: '6/18 關閉', closed: true, pos: 2 },
    ],
    cards: [],
  });
  assertEq(result.days.length, 1);
  assertEq(result.days[0].list_name, '6/18 開放');
});

test('過濾 closed 卡片', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18 維', closed: false, pos: 1 }],
    cards: [
      { id: 'c1', name: '活', idList: 'l1', closed: false, pos: 1, desc: '' },
      { id: 'c2', name: '封', idList: 'l1', closed: true, pos: 2, desc: '' },
    ],
  });
  assertEq(result.days[0].items.length, 1);
  assertEq(result.days[0].items[0].title, '活');
});

test('卡片依 pos 升冪排序', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18 維', closed: false, pos: 1 }],
    cards: [
      { id: 'c1', name: 'B', idList: 'l1', closed: false, pos: 200, desc: '' },
      { id: 'c2', name: 'A', idList: 'l1', closed: false, pos: 100, desc: '' },
      { id: 'c3', name: 'C', idList: 'l1', closed: false, pos: 300, desc: '' },
    ],
  });
  assertEq(result.days[0].items.map(i => i.title), ['A', 'B', 'C']);
});

test('非日期清單放到 extras', () => {
  const result = parseTrello({
    name: 't',
    lists: [
      { id: 'l1', name: '6/18 維', closed: false, pos: 1 },
      { id: 'l2', name: '購物', closed: false, pos: 2 },
      { id: 'l3', name: '餐廳', closed: false, pos: 3 },
    ],
    cards: [],
  });
  assertEq(result.days.length, 1);
  assert('購物' in result.extras);
  assert('餐廳' in result.extras);
});

test('卡片欄位完整映射', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18 維', closed: false, pos: 1 }],
    cards: [{
      id: 'c1', name: '聖史蒂芬大教堂', idList: 'l1', closed: false, pos: 1,
      desc: '# 標題\n\n細節說明',
      locationName: 'Stephansdom',
      address: 'Vienna',
      labels: [{ color: 'green', name: '必去' }],
      attachments: [{ url: 'https://x.com', name: '官網' }],
    }],
  });
  const item = result.days[0].items[0];
  assertEq(item.title, '聖史蒂芬大教堂');
  assertEq(item.desc, '# 標題\n\n細節說明');
  assertEq(item.place, 'Stephansdom');
  assertEq(item.labels, [{ color: 'green', name: '必去' }]);
  assertEq(item.attachments, [{ url: 'https://x.com', name: '官網' }]);
});

test('locationName 為空時 fallback 到 address', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18', closed: false, pos: 1 }],
    cards: [{ id: 'c1', name: 'x', idList: 'l1', closed: false, pos: 1, desc: '', locationName: '', address: 'Roma' }],
  });
  assertEq(result.days[0].items[0].place, 'Roma');
});

test('無日期清單會放 warning', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '購物', closed: false, pos: 1 }],
    cards: [],
  });
  assertEq(result.days.length, 0);
  assert(result.warnings.some(w => w.includes('日期')));
});
