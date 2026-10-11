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
  const cached = cache.get('branches');
  if (cached) return res.json(cached);

  try {
    const branches = await fetchBranches();
    cache.set('branches', branches, cache.TTL.BRANCHES);
    res.json(branches);
  } catch (err) {
    console.error('取得分店清單失敗，使用預設清單：', err.message);
    const fallback = getDefaultBranches();
    cache.set('branches', fallback, cache.TTL.BRANCHES);
    res.json(fallback);
  }
});

// ─── 課表（支援多週、整個縣市）────────────────────────────────────────────────

const VALID_TYPES = ['飛輪', '拳擊有氧', '全部'];
const MAX_REGION_WEEKS = 4;   // 整個縣市 × 多週請求量大，限制最多 4 週

async function getBranches() {
  const cached = cache.get('branches');
  if (cached) return cached;
  let branches;
  try { branches = await fetchBranches(); }
  catch (err) { console.error('取得分店清單失敗，使用預設清單：', err.message); branches = getDefaultBranches(); }
  cache.set('branches', branches, cache.TTL.BRANCHES);
  return branches;
}

// 每間分店、每一週各自快取（一律快取「全部」類型，類型篩選在回傳前套用）
async function getBranchWeek(branch, weekStart) {
  const key = `schedule:${branch}:${weekStart}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = await fetchSchedule(branch, '全部', weekStart);
  cache.set(key, result, cache.TTL.SCHEDULE);
  return result;
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

  await runPool(tasks, async ({ branch, weekStart }) => {
    try {
      const r = await getBranchWeek(branch, weekStart);
      r.classes.filter(c => matchesType(c.name, type)).forEach(c => classes.push({ ...c, branch }));
      if (!oldest || r.fetchedAt < oldest) oldest = r.fetchedAt;
    } catch (err) {
      console.error(`取得 ${branch} ${weekStart} 課表失敗：`, err.message);
      failed.push(branches.length > 1 ? `${branch}` : weekStart);
    }
  });

  return { classes, failed: [...new Set(failed)], tasks: tasks.length, fetchedAt: oldest || new Date().toISOString() };
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
  res.json({ classes: r.classes, weeks, failed: r.failed, fetchedAt: r.fetchedAt });
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
  res.json({ classes: r.classes, weeks, failed: r.failed, branchCount: found.branches.length, fetchedAt: r.fetchedAt });
});

// ─── API: 清除快取（手動刷新） ─────────────────────────────────────────────────

app.post('/api/refresh', async (req, res) => {
  const { branch, region } = req.body || {};
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
