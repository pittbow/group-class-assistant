/**
 * 健身工廠課表抓取
 * 直接呼叫官網課表頁使用的 AJAX 介面（不需要瀏覽器 / Puppeteer），再解析回傳的 HTML 課表。
 * 需要 Node 18+（內建 fetch）。
 */

const BASE_URL = 'https://www.fitnessfactory.com.tw';
const PAGE_URL = `${BASE_URL}/tw/course?page=schedule`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// 以 Monday 為第 0 欄；對應前端使用的「週X」
const WEEKDAYS_MON_FIRST = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

// 地區顯示順序（官網以 data-f 區域 id 對應縣市）
let session = { cookie: '', html: '', t: 0 };

async function getSession(force = false) {
  if (!force && session.cookie && Date.now() - session.t < 20 * 60 * 1000) return session;
  const res = await fetch(PAGE_URL, { headers: { 'User-Agent': UA } });
  const html = await res.text();
  session = {
    cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; '),
    html,
    t: Date.now(),
  };
  return session;
}

const decode = s => s
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/[<>]/g, '')   // 前端以 innerHTML 渲染，避免官網內容夾帶標籤
  .replace(/\s+/g, ' ').trim();

// ─── 分店清單 ─────────────────────────────────────────────────────────────────

/**
 * 結果格式：[{ region: '台北市', branches: ['台北信義', ...] }, ...]
 * branches 的值就是官網的 store key，也是 fetchSchedule 的 branch 參數。
 */
async function fetchBranches() {
  const { html } = await getSession();
  const areas = [...html.matchAll(/class="bkLocationArea[^"]*"[^>]*?data-id=['"](\d+)['"][^>]*>([^<]+)</g)]
    .map(m => ({ id: m[1], name: decode(m[2]) }));
  const stores = [...html.matchAll(/class="bkLocationStore[^"]*"\s+data-f=['"](\d+)['"]\s+data-id=['"]\d+['"]\s+data-url=['"]([^'"]+)['"]/g)]
    .map(m => ({ area: m[1], key: m[2] }));

  const result = areas
    .map(a => ({ region: a.name, branches: stores.filter(s => s.area === a.id).map(s => s.key) }))
    .filter(r => r.branches.length);
  if (!result.length) throw new Error('無法解析分店清單（官網版型可能已改版）');
  return result;
}

// ─── 課表 ─────────────────────────────────────────────────────────────────────

function todayTW() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseSchedule(scheduleView) {
  const classes = [];
  for (const row of scheduleView.split('<div class="tr">').slice(1)) {
    row.split('<div class="td">').slice(1, 8).forEach((cell, col) => {
      if (!cell.includes('course-box')) return;
      const pick = cls => (cell.match(new RegExp(`class="${cls}"[^>]*>([^]*?)</div>`)) || [])[1] || '';
      const [start = '', end = ''] = decode(pick('time')).split(/\s*-\s*/);
      const instructor = [...pick('teacher').matchAll(/<span>([\s\S]*?)<\/span>/g)]
        .map(m => decode(m[1])).filter(Boolean).join('、');
      classes.push({
        name: decode(pick('name')),
        time: start,
        endTime: end,
        instructor,
        weekday: WEEKDAYS_MON_FIRST[col],
        location: decode(pick('classroom')),
      });
    });
  }
  return classes;
}

// 官網課名沒有「拳擊」字樣；拳擊／格鬥類課程實際叫「武力對決」「戰鬥有氧」「極限戰鬥」
// （前端 public/index.html 的 CYCLE_RE / BOXING_RE 需與此保持一致）
const CYCLE_RE  = /飛輪|cycle|循環/i;
const BOXING_RE = /拳擊|boxing|武力對決|戰鬥|combat/i;

function matchesType(name, type) {
  if (type === '全部') return true;
  if (type === '飛輪') return CYCLE_RE.test(name);
  if (type === '拳擊有氧') return BOXING_RE.test(name);
  return true;
}

/**
 * 抓取指定分店「本週」課表
 * @param {string} branch - 分店 key（如 '台北信義'）
 * @param {string} type   - '飛輪' | '拳擊有氧' | '全部'
 */
async function fetchSchedule(branch, type = '全部') {
  console.log(`[Scraper] 抓取課表：${branch} / ${type}`);
  const q = new URLSearchParams({
    page: 'schedule', store: branch, cate: 0, class: 0, teacher: 0, room: 0, date: todayTW(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const { cookie } = await getSession(attempt > 0);
    const res = await fetch(`${BASE_URL}/tw/course/ajax/filterSchedule?${q}`, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Cookie: cookie,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
        Referer: PAGE_URL,
      },
    });
    if (!(res.headers.get('content-type') || '').includes('json')) continue; // session 失效，重取一次
    const data = await res.json();
    const classes = parseSchedule(data.scheduleView || '').filter(c => matchesType(c.name, type));
    return { classes, fetchedAt: new Date().toISOString(), source: 'api' };
  }
  throw new Error('官網回應異常（找不到該分店或官網暫時無法連線）');
}

// ─── 預設分店清單（官網暫時無法連線時的備援） ──────────────────────────────────

function getDefaultBranches() {
  return [
    { region: '台北市', branches: ['台北信義', '台北健康', '台北長春', '台北中山北'] },
    { region: '基隆市', branches: ['基隆基隆'] },
  ];
}

module.exports = { fetchBranches, fetchSchedule, getDefaultBranches };
