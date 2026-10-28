// 執行：npm test
// 解析測試使用固定的官網 HTML 片段（離線、不打官網）；官網改版時更新此片段與 scraper.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedule, matchesType, weekStarts } = require('../scraper');

const box = (name, time, room, teachers) => `
  <div class="td">
    <div class="course-box" style="--bg-color: transparent; --text-color: #000;">
      <div class="name">${name}</div>
      <div class="time">${time}</div>
      <div class="classroom">${room}</div>
      <div class="teacher">${teachers.map(t => `<span>${t}</span>`).join('')}</div>
    </div>
  </div>`;
const empty = '<div class="td"></div>';

// 一列 7 欄（週一～週日），與官網 scheduleView 的結構相同
const FIXTURE =
  `<div class="tr">${box('飛輪課程', '10:50 - 11:40', '飛輪教室', ['Ally W.'])}${empty}${box('武力對決', '19:10 - 20:10', '有氧大教室', ['阿沖', '小詹'])}${empty}${empty}${empty}${box('哈達瑜珈 &amp; 伸展', '09:00 - 10:00', '有氧大教室', ['Makoto H.'])}</div>` +
  `<div class="tr">${empty}${box('<b>E-Cycle-間歇循環</b>', '07:30 - 08:15', '飛輪教室', [])}${empty}${empty}${empty}${empty}${empty}</div>`;

test('parseSchedule：欄位、星期與日期', () => {
  const classes = parseSchedule(FIXTURE, '2026-10-26');
  assert.equal(classes.length, 4);

  const [cycle, boxing, yoga, ecycle] = classes;
  assert.deepEqual(cycle, {
    name: '飛輪課程', time: '10:50', endTime: '11:40', instructor: 'Ally W.',
    weekday: '週一', date: '2026-10-26', location: '飛輪教室',
  });
  assert.equal(boxing.weekday, '週三');
  assert.equal(boxing.date, '2026-10-28');
  assert.equal(boxing.instructor, '阿沖、小詹');
  assert.equal(yoga.weekday, '週日');
  assert.equal(yoga.date, '2026-11-01');           // 跨月
  assert.equal(yoga.name, '哈達瑜珈 & 伸展');        // HTML 實體解碼
  assert.equal(ecycle.name, 'E-Cycle-間歇循環');    // 去除標籤
  assert.equal(ecycle.instructor, '');
});

test('parseSchedule：不留下可被當成 HTML 的角括號', () => {
  const [c] = parseSchedule(`<div class="tr">${box('&lt;img src=x onerror=alert(1)&gt;', '10:00 - 11:00', '', [])}</div>`, '2026-10-26');
  assert.ok(!/[<>]/.test(c.name));
});

test('parseSchedule：空白課表', () => {
  assert.deepEqual(parseSchedule('', '2026-10-26'), []);
});

test('matchesType：飛輪與拳擊／格鬥分類', () => {
  assert.ok(matchesType('飛輪課程', '飛輪'));
  assert.ok(matchesType('E-Cycle-耐力循環', '飛輪'));
  assert.ok(matchesType('武力對決', '拳擊有氧'));
  assert.ok(matchesType('戰鬥有氧', '拳擊有氧'));
  assert.ok(matchesType('極限戰鬥', '拳擊有氧'));
  assert.ok(!matchesType('哈達瑜珈', '飛輪'));
  assert.ok(!matchesType('哈達瑜珈', '拳擊有氧'));
  assert.ok(matchesType('哈達瑜珈', '全部'));
});

test('weekStarts：從本週一起連續的週一，且有上限', () => {
  const weeks = weekStarts(3);
  assert.equal(weeks.length, 3);
  for (const w of weeks) assert.equal(new Date(w + 'T00:00:00Z').getUTCDay(), 1);
  assert.equal(new Date(weeks[1]) - new Date(weeks[0]), 7 * 86400e3);
  assert.equal(weekStarts(999).length, weekStarts(8).length);
  assert.equal(weekStarts(0).length, 1);
});
