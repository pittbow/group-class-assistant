/**
 * 健身工廠課表爬蟲
 * 使用 Puppeteer 模擬瀏覽器操作，抓取飛輪與拳擊有氧課表
 */

const puppeteer = require('puppeteer');

const BASE_URL = 'https://www.fitnessfactory.com.tw';
const SCHEDULE_URL = `${BASE_URL}/tw/course?page=schedule`;

// 課程分類對應官網選項文字
const COURSE_TYPE_LABELS = {
  '飛輪':   '飛輪課程',
  '拳擊有氧': '心肺/訓練課程',
};

// 星期對應
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// ─── Browser helper ──────────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--lang=zh-TW',
    ],
  });
}

// ─── Fetch branch list ────────────────────────────────────────────────────────

/**
 * 從官網抓取所有分店清單（依區域分組）
 * 結果格式：[{ region: '台北市', branches: ['台北萬隆', '台北信義', ...] }, ...]
 */
async function fetchBranches() {
  console.log('[Scraper] 正在抓取分店清單...');
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-TW,zh;q=0.9' });
    await page.goto(SCHEDULE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 等待頁面完整載入
    await page.waitForTimeout(3000);

    // 嘗試找到區域選單並取得所有選項
    const regions = await page.evaluate(() => {
      const result = [];

      // 找所有 select 元素或自定義下拉選單
      const selects = document.querySelectorAll('select');
      selects.forEach(sel => {
        const options = Array.from(sel.options).map(o => o.textContent.trim()).filter(t => t && t !== '選擇區域' && t !== '選擇廠館' && t !== '選擇課程分類' && t !== '選擇上課老師');
        if (options.length > 5) result.push({ selectId: sel.id, selectName: sel.name, options });
      });

      // 也嘗試找 li 或 div 型態的自定義下拉
      const dropdowns = document.querySelectorAll('[class*="dropdown"], [class*="select"], [class*="filter"]');
      dropdowns.forEach(dd => {
        const items = Array.from(dd.querySelectorAll('li, option, [class*="item"], [class*="option"]'))
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0 && t.length < 20);
        if (items.length > 0) result.push({ type: 'custom', items });
      });

      return result;
    });

    console.log('[Scraper] 找到下拉元素：', JSON.stringify(regions, null, 2));

    // 嘗試抓取區域列表（點選區域下拉後取得選項）
    const regionData = await extractRegionBranchData(page);

    await browser.close();
    return regionData;

  } catch (err) {
    await browser.close();
    console.error('[Scraper] 抓取分店清單失敗：', err.message);
    // 回傳預設清單
    return getDefaultBranches();
  }
}

async function extractRegionBranchData(page) {
  try {
    // 嘗試找到區域選單（select 或自定義）
    // 策略 1：標準 select 元素
    const selectHandles = await page.$$('select');
    if (selectHandles.length >= 2) {
      // 通常第一個是區域，第二個是廠館
      const regionSelect = selectHandles[0];
      const regionOptions = await page.evaluate(sel => {
        return Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent.trim() })).filter(o => o.text && !o.text.includes('選擇'));
      }, regionSelect);

      if (regionOptions.length > 0) {
        const regionBranches = [];
        for (const region of regionOptions) {
          // 選擇區域
          await page.select('select:first-of-type', region.value);
          await page.waitForTimeout(1000);

          // 取廠館選單
          const branchOptions = await page.evaluate(sel => {
            return Array.from(sel.options).map(o => o.textContent.trim()).filter(t => t && !t.includes('選擇'));
          }, selectHandles[1]);

          regionBranches.push({ region: region.text, branches: branchOptions });
        }
        return regionBranches;
      }
    }
  } catch (e) {
    console.log('[Scraper] 標準 select 方式失敗，改用預設清單：', e.message);
  }

  return getDefaultBranches();
}

// ─── Fetch schedule ───────────────────────────────────────────────────────────

/**
 * 抓取指定分店的課表
 * @param {string} branch   - 分店名稱（如 '台北信義'）
 * @param {string} type     - '飛輪' | '拳擊有氧' | '全部'
 * @returns {{ classes: Array, fetchedAt: string }}
 */
async function fetchSchedule(branch, type = '全部') {
  console.log(`[Scraper] 抓取課表：${branch} / ${type}`);
  const browser = await launchBrowser();
  const page = await browser.newPage();

  // 攔截 API 回應
  let capturedApiData = null;
  page.on('response', async (response) => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (ct.includes('json') && url.includes(BASE_URL) && !url.includes('analytics') && !url.includes('gtm')) {
      try {
        const data = await response.json();
        if (data && (Array.isArray(data) || data.data || data.schedule || data.courses || data.list)) {
          console.log('[Scraper] 偵測到 API 回應：', url);
          capturedApiData = { url, data };
        }
      } catch (e) {}
    }
  });

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-TW,zh;q=0.9' });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(SCHEDULE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(2000);

    // ── 選擇分店 ──
    await selectOption(page, branch);
    await page.waitForTimeout(2000);

    // ── 選擇課程類型 ──
    if (type !== '全部') {
      const label = COURSE_TYPE_LABELS[type];
      if (label) {
        await selectOption(page, label);
        await page.waitForTimeout(2000);
      }
    }

    // 等待課表載入
    await page.waitForTimeout(3000);

    // 如果攔截到 API，解析 API 資料
    if (capturedApiData) {
      const classes = parseApiData(capturedApiData.data, type);
      await browser.close();
      return { classes, fetchedAt: new Date().toISOString(), source: 'api' };
    }

    // 否則解析 HTML
    const classes = await parseScheduleFromPage(page, type);
    await browser.close();
    return { classes, fetchedAt: new Date().toISOString(), source: 'html' };

  } catch (err) {
    try { await browser.close(); } catch (_) {}
    console.error('[Scraper] 抓取課表失敗：', err.message);
    throw err;
  }
}

// ─── Select helpers ───────────────────────────────────────────────────────────

/**
 * 通用選項選擇：嘗試 select 元素、自定義下拉、包含文字的元素
 */
async function selectOption(page, targetText) {
  try {
    // 方式 1：標準 select 元素
    const selected = await page.evaluate((text) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.textContent.trim().includes(text)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }
      return false;
    }, targetText);

    if (selected) {
      console.log(`[Scraper] 選擇成功 (select)：${targetText}`);
      return;
    }

    // 方式 2：點選包含目標文字的 li / div / span
    const el = await page.$x(`//*[contains(text(), "${targetText}") and (self::li or self::div or self::span or self::a or self::option)]`);
    if (el.length > 0) {
      await el[0].click();
      console.log(`[Scraper] 選擇成功 (click)：${targetText}`);
      return;
    }

    console.log(`[Scraper] 找不到選項：${targetText}`);
  } catch (e) {
    console.log(`[Scraper] 選擇選項時出錯 (${targetText})：`, e.message);
  }
}

// ─── Parse HTML ───────────────────────────────────────────────────────────────

async function parseScheduleFromPage(page, filterType) {
  const classes = await page.evaluate((weekdays, courseTypeLabels, filterType) => {
    const result = [];

    // 嘗試找課表格子 — 常見選擇器
    const selectors = [
      '.schedule-item', '.course-item', '.class-item',
      '[class*="schedule"]', '[class*="course"]', '[class*="class-card"]',
      'td[class*="course"]', '.timetable td',
    ];

    let items = [];
    for (const sel of selectors) {
      items = document.querySelectorAll(sel);
      if (items.length > 0) break;
    }

    if (items.length === 0) {
      // 最後手段：找所有含有時間格式（HH:MM）的元素
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.children.length === 0 && /\d{1,2}:\d{2}/.test(el.textContent)) {
          items = Array.from(document.querySelectorAll(el.parentElement?.tagName || 'li'));
          break;
        }
      }
    }

    items.forEach(item => {
      const text = item.textContent.trim();
      if (!text) return;

      // 嘗試解析課程資訊
      const timeMatch  = text.match(/(\d{1,2}):(\d{2})/g);
      const nameMatch  = text.match(/飛輪|E-Cycle|拳擊有氧|BOXING|AEROBIC|PIYO|FORCE/i);

      if (timeMatch && timeMatch.length > 0) {
        const courseName = item.querySelector('[class*="name"], [class*="title"], h3, h4, strong')?.textContent.trim() || '';
        const instructor = item.querySelector('[class*="teacher"], [class*="instructor"]')?.textContent.trim() || '';
        const timeText   = item.querySelector('[class*="time"]')?.textContent.trim() || timeMatch[0];

        result.push({
          name:       courseName || text.split('\n')[0].trim(),
          time:       timeText,
          instructor: instructor,
          weekday:    '',
          rawText:    text.slice(0, 100),
        });
      }
    });

    return result;
  }, WEEKDAYS, COURSE_TYPE_LABELS, filterType);

  return classes;
}

// ─── Parse API data ───────────────────────────────────────────────────────────

function parseApiData(data, filterType) {
  try {
    let list = Array.isArray(data) ? data : (data.data || data.courses || data.schedule || data.list || []);
    if (!Array.isArray(list)) list = Object.values(list).flat();

    return list
      .filter(item => {
        if (filterType === '全部') return true;
        const name = (item.name || item.courseName || item.title || '').toLowerCase();
        if (filterType === '飛輪')    return name.includes('飛輪') || name.includes('cycle') || name.includes('e-cycle');
        if (filterType === '拳擊有氧') return name.includes('拳擊') || name.includes('boxing') || name.includes('aerobic') || name.includes('piyo');
        return true;
      })
      .map(item => ({
        name:       item.name || item.courseName || item.title || '未知課程',
        time:       item.time || item.startTime  || item.courseTime || '',
        endTime:    item.endTime   || '',
        instructor: item.teacher   || item.instructor || item.coachName || '',
        weekday:    item.weekday   || item.dayOfWeek  || '',
        date:       item.date      || '',
        location:   item.room      || item.location   || '',
        spots:      item.spots     || item.availableSpots || null,
      }));
  } catch (e) {
    console.error('[Scraper] 解析 API 資料失敗：', e.message);
    return [];
  }
}

// ─── Default branch list ──────────────────────────────────────────────────────

/**
 * 預設分店清單（官網抓取失敗時使用）
 * 資料來源：健身工廠官網 2024 年公開資訊
 */
function getDefaultBranches() {
  return [
    {
      region: '基隆市',
      branches: ['基隆基隆']
    },
    {
      region: '台北市',
      branches: ['台北萬隆', '台北信義', '台北中山北', '台北南港', '台北內湖', '台北士林', '台北天母', '台北木柵', '台北文山', '台北北投', '台北關渡']
    },
    {
      region: '新北市',
      branches: ['新北板橋', '新北三重', '新北新莊', '新北永和', '新北中和', '新北土城', '新北樹林', '新北林口', '新北汐止', '新北新店', '新北淡水', '新北蘆洲', '新北三峽']
    },
    {
      region: '桃園市',
      branches: ['桃園桃園', '桃園中壢', '桃園平鎮', '桃園蘆竹', '桃園八德', '桃園龜山', '桃園楊梅']
    },
    {
      region: '新竹市/縣',
      branches: ['新竹新竹', '新竹竹北', '新竹竹東']
    },
    {
      region: '苗栗縣',
      branches: ['苗栗苗栗', '苗栗頭份']
    },
    {
      region: '台中市',
      branches: ['台中松竹', '台中大里', '台中北屯', '台中西屯', '台中沙鹿', '台中豐原', '台中太平', '台中烏日', '台中大甲']
    },
    {
      region: '彰化縣',
      branches: ['彰化彰化', '彰化員林']
    },
    {
      region: '南投縣',
      branches: ['南投南投', '南投草屯']
    },
    {
      region: '雲林縣',
      branches: ['雲林斗六']
    },
    {
      region: '嘉義市/縣',
      branches: ['嘉義嘉義']
    },
    {
      region: '台南市',
      branches: ['台南永康', '台南台南', '台南新市', '台南仁德', '台南東區']
    },
    {
      region: '高雄市',
      branches: ['高雄博愛', '高雄三民', '高雄鳳山', '高雄楠梓', '高雄左營', '高雄苓雅', '高雄仁武']
    },
    {
      region: '屏東縣',
      branches: ['屏東屏東', '屏東潮州']
    },
    {
      region: '宜蘭縣',
      branches: ['宜蘭宜蘭']
    },
    {
      region: '花蓮縣',
      branches: ['花蓮花蓮']
    },
  ];
}

module.exports = { fetchBranches, fetchSchedule, getDefaultBranches };
