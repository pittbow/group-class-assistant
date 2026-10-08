const express  = require('express');
const path     = require('path');
const cache    = require('./cache');
const { fetchBranches, fetchSchedule, getDefaultBranches } = require('./scraper');

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

// ─── API: 取得課表 ────────────────────────────────────────────────────────────

app.get('/api/schedule', async (req, res) => {
  const { branch, type = '全部' } = req.query;

  if (!branch) {
    return res.status(400).json({ error: '請提供分店名稱 (branch)' });
  }

  const validTypes = ['飛輪', '拳擊有氧', '全部'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `課程類型必須是：${validTypes.join('、')}` });
  }

  const cacheKey = `schedule:${branch}:${type}`;
  const cached   = cache.get(cacheKey);
  if (cached) {
    console.log(`[Cache hit] ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const result = await fetchSchedule(branch, type);
    cache.set(cacheKey, result, cache.TTL.SCHEDULE);
    res.json(result);
  } catch (err) {
    console.error('取得課表失敗：', err.message);
    res.status(500).json({
      error: '無法取得課表，請稍後再試',
      detail: err.message,
    });
  }
});

// ─── API: 取得整個縣市所有分店的課表 ───────────────────────────────────────────

async function getBranches() {
  const cached = cache.get('branches');
  if (cached) return cached;
  let branches;
  try { branches = await fetchBranches(); }
  catch (err) { console.error('取得分店清單失敗，使用預設清單：', err.message); branches = getDefaultBranches(); }
  cache.set('branches', branches, cache.TTL.BRANCHES);
  return branches;
}

// 每間分店的課表共用同一份快取（一律快取「全部」類型，由前端依類型／關鍵字篩選）
async function getBranchSchedule(branch) {
  const key = `schedule:${branch}:全部`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = await fetchSchedule(branch, '全部');
  cache.set(key, result, cache.TTL.SCHEDULE);
  return result;
}

app.get('/api/region-schedule', async (req, res) => {
  const { region } = req.query;
  if (!region) return res.status(400).json({ error: '請提供縣市名稱 (region)' });

  const found = (await getBranches()).find(r => r.region === region);
  if (!found) return res.status(404).json({ error: `找不到縣市：${region}` });

  const queue = [...found.branches];
  const classes = [];
  const failed = [];
  let oldest = null;

  // 同時最多 4 個請求，避免一次對官網送出太多
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const branch = queue.shift();
      try {
        const r = await getBranchSchedule(branch);
        r.classes.forEach(c => classes.push({ ...c, branch }));
        if (!oldest || r.fetchedAt < oldest) oldest = r.fetchedAt;
      } catch (err) {
        console.error(`取得 ${branch} 課表失敗：`, err.message);
        failed.push(branch);
      }
    }
  }));

  if (!classes.length && failed.length) {
    return res.status(500).json({ error: '無法取得課表，請稍後再試', failed });
  }
  res.json({ classes, failed, branchCount: found.branches.length, fetchedAt: oldest || new Date().toISOString() });
});

// ─── API: 清除快取（手動刷新） ─────────────────────────────────────────────────

app.post('/api/refresh', (req, res) => {
  const { branch, type, region } = req.body;
  if (region) {
    const found = (cache.get('branches') || []).find(r => r.region === region);
    (found ? found.branches : []).forEach(b => cache.del(`schedule:${b}:全部`));
    res.json({ message: `已清除 ${region} 的快取` });
  } else if (branch) {
    cache.del(`schedule:${branch}:${type || '全部'}`);
    res.json({ message: `已清除 ${branch} 的快取` });
  } else {
    res.json({ message: '請提供 branch 參數' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`團課小幫手正在運行：http://localhost:${PORT}`);
  console.log(`請用瀏覽器開啟，或掃描 QR Code 在手機上使用`);
});
