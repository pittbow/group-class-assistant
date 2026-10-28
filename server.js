const express  = require('express');
const path     = require('path');
const cache    = require('./cache');
const { fetchBranches, fetchSchedule, getDefaultBranches, weekStarts, matchesType } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: 取得所有分店清單 ────────────────────────────────────────────────────

app.get('/api/branches', async (req, res) => {
  res.json(await getBranches());
});

// ─── 課表（支援多週、整個縣市）────────────────────────────────────────────────

const VALID_TYPES = ['飛輪', '拳擊有氧', '全部'];
const MAX_REGION_WEEKS = 5;   // 整個縣市 × 多週請求量大，限制最多 5 週（涵蓋本週起約 4 週的公布範圍）

// 同一個 key 同時有多個請求時，只向官網抓一次
const inflight = new Map();
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function getBranches() {
  const cached = cache.get('branches');
  if (cached) return cached;
  return once('branches', async () => {
    try {
      const branches = await fetchBranches();
      cache.set('branches', branches, cache.TTL.BRANCHES);
      return branches;
    } catch (err) {
      // 先用上一次成功的清單；都沒有才用預設清單，且只快取 5 分鐘，避免整天卡在不完整的清單
      const stale = cache.getStale('branches');
      console.error('取得分店清單失敗，改用', stale ? '上一次的清單' : '預設清單', '：', err.message);
      const fallback = stale || getDefaultBranches();
      cache.set('branches', fallback, cache.TTL.BRANCHES_FALLBACK);
      return fallback;
    }
  });
}

// 每間分店、每一週各自快取（一律快取「全部」類型，類型篩選在回傳前套用）
// 官網失敗時若有舊資料，回傳舊資料並標記 stale
async function getBranchWeek(branch, weekStart) {
  const key = `schedule:${branch}:${weekStart}`;
  const cached = cache.get(key);
  if (cached) return cached;
  return once(key, async () => {
    try {
      const result = await fetchSchedule(branch, '全部', weekStart);
      cache.set(key, result, result.classes.length ? cache.TTL.SCHEDULE : cache.TTL.SCHEDULE_EMPTY);
      return result;
    } catch (err) {
      const stale = cache.getStale(key);
      if (stale) {
        console.error(`取得 ${branch} ${weekStart} 課表失敗，改用舊資料：`, err.message);
        return { ...stale, stale: true };
      }
      throw err;
    }
  });
}

// 同時最多 4 個請求，避免一次對官網送出太多
async function runPool(tasks, worker, limit = 4) {
  const queue = [...tasks];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

async function collect(branches, weeks, type) {
  const tasks = branches.flatMap(branch => weekStarts(weeks).map(weekStart => ({ branch, weekStart })));
  const classes = [];
  const failed = [];
  let oldest = null;
  let stale = false;

  await runPool(tasks, async ({ branch, weekStart }) => {
    try {
      const r = await getBranchWeek(branch, weekStart);
      // 只有整個縣市查詢時才標示分店（單一分店時每張卡片都寫同一間是多餘的）
      const multi = branches.length > 1;
      r.classes.filter(c => matchesType(c.name, type)).forEach(c => classes.push(multi ? { ...c, branch } : { ...c }));
      if (!oldest || r.fetchedAt < oldest) oldest = r.fetchedAt;
      if (r.stale) stale = true;
    } catch (err) {
      console.error(`取得 ${branch} ${weekStart} 課表失敗：`, err.message);
      failed.push(branches.length > 1 ? `${branch}` : weekStart);
    }
  });

  return { classes, failed: [...new Set(failed)], stale, tasks: tasks.length, fetchedAt: oldest || new Date().toISOString() };
}

function parseWeeks(raw, max) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : 1;
}

app.get('/api/schedule', async (req, res) => {
  const { branch, type = '全部' } = req.query;
  if (!branch) return res.status(400).json({ error: '請提供分店名稱 (branch)' });
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `課程類型必須是：${VALID_TYPES.join('、')}` });
  }
  const weeks = parseWeeks(req.query.weeks, weekStarts(99).length);

  const r = await collect([branch], weeks, type);
  if (!r.classes.length && r.failed.length) {
    // 連第一週都抓不到才視為失敗（較遠的週官網本來就可能沒公布）
    try { await getBranchWeek(branch, weekStarts(1)[0]); }
    catch (err) { return res.status(500).json({ error: '無法取得課表，請稍後再試', detail: err.message }); }
  }
  res.json({ classes: r.classes, weeks, failed: r.failed, stale: r.stale, fetchedAt: r.fetchedAt });
});

app.get('/api/region-schedule', async (req, res) => {
  const { region, type = '全部' } = req.query;
  if (!region) return res.status(400).json({ error: '請提供縣市名稱 (region)' });
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `課程類型必須是：${VALID_TYPES.join('、')}` });
  }
  const weeks = parseWeeks(req.query.weeks, MAX_REGION_WEEKS);

  const found = (await getBranches()).find(r => r.region === region);
  if (!found) return res.status(404).json({ error: `找不到縣市：${region}` });

  const r = await collect(found.branches, weeks, type);
  if (!r.classes.length && r.failed.length) {
    return res.status(500).json({ error: '無法取得課表，請稍後再試', failed: r.failed });
  }
  res.json({ classes: r.classes, weeks, failed: r.failed, stale: r.stale, branchCount: found.branches.length, fetchedAt: r.fetchedAt });
});

// ─── API: 清除快取（手動刷新） ─────────────────────────────────────────────────

const REFRESH_COOLDOWN_MS = 60 * 1000;
const lastRefresh = new Map();

app.post('/api/refresh', async (req, res) => {
  const { branch, region } = req.body || {};
  const target = region ? `region:${region}` : branch ? `branch:${branch}` : '';
  if (target && Date.now() - (lastRefresh.get(target) || 0) < REFRESH_COOLDOWN_MS) {
    return res.json({ message: '剛剛已重新抓取過，請稍後再試', throttled: true });
  }
  if (target) lastRefresh.set(target, Date.now());
  if (region) {
    const found = (await getBranches()).find(r => r.region === region);
    (found ? found.branches : []).forEach(b => cache.delPrefix(`schedule:${b}:`));
    res.json({ message: `已清除 ${region} 的快取` });
  } else if (branch) {
    cache.delPrefix(`schedule:${branch}:`);
    res.json({ message: `已清除 ${branch} 的快取` });
  } else {
    res.json({ message: '請提供 branch 或 region 參數' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`團課小幫手正在運行：http://localhost:${PORT}`);
  console.log(`請用瀏覽器開啟，或掃描 QR Code 在手機上使用`);
});
