/**
 * 簡易記憶體快取
 * 課表資料：快取 4 小時
 * 分店清單：快取 24 小時
 */

const store = new Map();

function set(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function del(key) {
  store.delete(key);
}

const TTL = {
  BRANCHES: 24 * 60 * 60 * 1000,  // 24 小時
  SCHEDULE:  4 * 60 * 60 * 1000,  //  4 小時
};

module.exports = { get, set, del, TTL };
