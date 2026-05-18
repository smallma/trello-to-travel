import { toCopyJson } from '../exporter.js';

group('toCopyJson');

const sampleData = {
  trip: '測試行程',
  days: [
    {
      list_name: '6/18 (四) 維也納',
      date: '6/18',
      items: [
        { title: '聖史蒂芬大教堂', desc: '細節', place: 'Stephansdom' },
        { title: '吃晚餐' },
      ],
    },
  ],
  extras: {
    '購物': [{ title: 'Outlet' }],
    '餐廳': [{ title: '推薦餐廳' }],
  },
  warnings: [],
};

test('includeExtras=true 時包含 extras key', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: true }));
  assert(obj.extras);
  assertEq(Object.keys(obj.extras), ['購物', '餐廳']);
});

test('includeExtras=false 時不含 extras key', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: false }));
  assert(!('extras' in obj));
});

test('含 trip / exported_at / days 必要欄位', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: false }));
  assertEq(obj.trip, '測試行程');
  assert(typeof obj.exported_at === 'string');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(obj.exported_at));
  assertEq(obj.days.length, 1);
});

test('days[i].items 保留所有欄位', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: false }));
  const item = obj.days[0].items[0];
  assertEq(item.title, '聖史蒂芬大教堂');
  assertEq(item.desc, '細節');
  assertEq(item.place, 'Stephansdom');
});

test('輸出是格式化的 JSON（含換行）', () => {
  const json = toCopyJson(sampleData, { includeExtras: false });
  assert(json.includes('\n'), 'JSON should be pretty-printed');
});
