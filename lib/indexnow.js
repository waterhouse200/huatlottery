// ─── lib/indexnow.js ── Tell search engines about new URLs immediately ─
//
// A sitemap is a passive invitation: engines re-read it when they feel like it,
// which can be days. IndexNow is a push — one POST naming the URLs that changed
// and Bing, Yandex, Seznam and Naver queue them for crawl straight away. It
// costs nothing and is the single biggest lever on "how fast does a new
// announcement page get indexed".
//
// (Google does not participate in IndexNow, and retired its own sitemap ping in
// 2023 — for Google the sitemap's honest per-URL lastmod, which server.js
// already emits, is the mechanism. So we ping the engines that accept a ping
// and let the sitemap do its job for the one that doesn't.)
//
// Ownership is proved by serving the key back as plain text at a known URL;
// server.js exposes /<key>.txt for exactly that. The key is not a secret — it
// is published by design.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY_FILE = path.join(__dirname, "..", ".indexnow-key");
const ENDPOINT = "https://api.indexnow.org/indexnow";

// Key precedence: env var (set it on the VPS to pin one), else a generated file
// that persists across restarts. A key that changed every boot would invalidate
// the verification file and silently break every submission.
function getKey() {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY.trim();
  try {
    const existing = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (existing) return existing;
  } catch (e) { /* not created yet */ }
  const key = crypto.randomBytes(16).toString("hex"); // 32 hex chars, within IndexNow's 8–128 range
  try { fs.writeFileSync(KEY_FILE, key + "\n", { mode: 0o644 }); } catch (e) { /* read-only fs — env var path only */ }
  return key;
}

// Submit up to 10,000 URLs in one call. Returns a short result object and never
// throws: failing to notify a search engine must not fail the publish that
// triggered it.
async function submit(urls, { site = "https://huatlottery.com" } = {}) {
  const list = [...new Set((urls || []).filter(Boolean))].slice(0, 10000);
  if (!list.length) return { ok: false, skipped: "no urls" };

  const key = getKey();
  const host = site.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const body = {
    host,
    key,
    keyLocation: `${site.replace(/\/+$/, "")}/${key}.txt`,
    urlList: list.map((u) => (u.startsWith("http") ? u : `${site.replace(/\/+$/, "")}${u}`)),
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // 200 accepted, 202 accepted-pending-key-validation. Both are successes.
    const ok = res.status === 200 || res.status === 202;
    console.log(`[indexnow] ${list.length} url(s) → HTTP ${res.status}${ok ? "" : " (not accepted)"}`);
    return { ok, status: res.status, count: list.length };
  } catch (err) {
    console.log(`[indexnow] submission failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { submit, getKey, KEY_FILE };
