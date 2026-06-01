// ─── i18n/index.js ── Tiny EN/中文 dictionary loader ─────────────────

const en = require("./en.json");
const zh = require("./zh.json");

const DICTS = { en, zh };

// Pick lang from explicit ?lang= query, else Accept-Language header, else en.
function pickLang(req) {
  const q = String(req.query?.lang || "").toLowerCase();
  if (q === "en" || q === "zh") return q;
  const hdr = String(req.headers?.["accept-language"] || "").toLowerCase();
  if (hdr.startsWith("zh") || hdr.includes(",zh") || hdr.includes(" zh")) return "zh";
  return "en";
}

function dict(lang) {
  return DICTS[lang] || DICTS.en;
}

module.exports = { pickLang, dict };
