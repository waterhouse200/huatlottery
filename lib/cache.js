// ─── lib/cache.js ── Request-level cache with disk persistence ─────────
//
// Goal: zero-wait UX for every user. Heavy endpoints (Profitable Buckets,
// Robustness Heatmap, Yearly Regulars, etc.) get cached by (path + query).
// Cache survives Render free-tier sleep/wake via disk persistence.
//
// Usage in endpoints:
//   app.get('/api/fourd/profitable-buckets', (req, res) => {
//     try {
//       const data = cache.compute(req, () => {
//         // existing expensive logic — returns the full data object
//         return { ... };
//       });
//       res.json({ success: true, data });
//     } catch (err) { ... }
//   });
//
// Default TTL: 1 hour. Override per-endpoint by passing { ttlMs } as 3rd arg.

const fs   = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "..", "cache");
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}

const memory = new Map();  // key → { value, ts }

const DEFAULT_TTL_MS = 60 * 60 * 1000;  // 1 hour

function safeName(key) {
  return key.replace(/[^a-z0-9_\-]/gi, "_").slice(0, 200);
}

function diskPath(key) {
  return path.join(CACHE_DIR, safeName(key) + ".json");
}

function loadFromDisk(key) {
  try {
    const raw = fs.readFileSync(diskPath(key), "utf8");
    return JSON.parse(raw);   // { value, ts }
  } catch (e) { return null; }
}

function saveToDisk(key, entry) {
  try {
    fs.writeFileSync(diskPath(key), JSON.stringify(entry));
  } catch (e) {
    console.warn("[cache] disk save failed for", key, e.message);
  }
}

// Build a stable cache key from an Express req object.
function keyForReq(req) {
  const sortedQuery = Object.keys(req.query)
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join("&");
  return `${req.path}__${sortedQuery || "default"}`;
}

// Lookup, compute on miss, persist, return.
function compute(req, computeFn, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const key = keyForReq(req);
  const now = Date.now();

  // Memory hit?
  const mem = memory.get(key);
  if (mem && now - mem.ts < ttlMs) return mem.value;

  // Disk hit?
  if (!mem) {
    const fromDisk = loadFromDisk(key);
    if (fromDisk && now - fromDisk.ts < ttlMs) {
      memory.set(key, fromDisk);
      return fromDisk.value;
    }
  }

  // Cold compute
  const t0 = Date.now();
  const value = computeFn();
  const entry = { value, ts: now };
  memory.set(key, entry);
  saveToDisk(key, entry);
  console.log(`[cache] MISS ${key} computed in ${Date.now() - t0}ms`);
  return value;
}

// Force-recompute (used by warmup + background refresh).
function refresh(req, computeFn) {
  const key = keyForReq(req);
  const t0 = Date.now();
  try {
    const value = computeFn();
    const entry = { value, ts: Date.now() };
    memory.set(key, entry);
    saveToDisk(key, entry);
    console.log(`[cache] refresh ${key} in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`[cache] refresh ${key} failed:`, err.message);
  }
}

// Wrap an existing Express handler with caching. The handler MUST be
// synchronous and call res.json({ success:true, data }) exactly once.
// Errors thrown by the handler propagate as 500 responses.
function withCache(handler, opts = {}) {
  return (req, res) => {
    try {
      const data = compute(req, () => {
        let captured;
        const fakeRes = {
          json: (body) => {
            if (body && body.success === false) {
              throw new Error(body.error || "handler returned error");
            }
            captured = body && body.data !== undefined ? body.data : body;
          },
          status: function () { return this; },
        };
        handler(req, fakeRes);
        if (captured === undefined) throw new Error("handler did not call res.json");
        return captured;
      }, opts);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

// Invalidate everything (memory + disk). Call when new data lands (e.g. a new
// draw) so cached endpoints recompute instead of serving stale results for the
// full TTL. A new draw changes essentially every derived stat, so clearing all
// is correct, not wasteful — entries rebuild lazily on next request.
function clear() {
  memory.clear();
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.endsWith(".json")) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (e) {} }
    }
  } catch (e) { /* dir may not exist yet — fine */ }
}

module.exports = { compute, refresh, keyForReq, withCache, clear };
