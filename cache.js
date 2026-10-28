/**
 * 簡易記憶體快取
 * 課表資料：快取 4 小時（尚未公布的空白週只快取 30 分鐘）
 * 分店清單：快取 24 小時（官網失敗時的備援清單只快取 5 分鐘）
 *
 * 過期的資料不會立刻刪除：官網暫時連不上時，可以用 getStale() 先回傳上一次成功的結果。
 */

const store = new Map();

function set(key, value, ttlMs) {
  store.set(key, { value, savedAt: Date.now(), expiresAt: Date.now() + ttlMs });
}

// 只回傳未過期的資料
function get(key) {
  const entry = store.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.value;
}

// 不論是否過期都回傳（供官網失敗時備援）
function getStale(key) {
  const entry = store.get(key);
  return entry ? entry.value : null;
}

function savedAt(key) {
  const entry = store.get(key);
  return entry ? entry.savedAt : 0;
}

function del(key) {
  store.delete(key);
}

function delPrefix(prefix) {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

const TTL = {
  BRANCHES:          24 * 60 * 60 * 1000,  // 24 小時
  BRANCHES_FALLBACK:      5 * 60 * 1000,  //  5 分鐘：官網失敗時的預設清單，盡快重試
  SCHEDULE:           4 * 60 * 60 * 1000,  //  4 小時
  SCHEDULE_EMPTY:        30 * 60 * 1000,  // 30 分鐘：空白週可能只是官網尚未公布
};

module.exports = { get, getStale, savedAt, set, del, delPrefix, TTL };
