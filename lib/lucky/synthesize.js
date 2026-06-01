// ─── lib/lucky/synthesize.js ── Combine system votes → final picks ────
//
// Each system produces digitWeights[0..9] and numberWeights[1..49].
// We sum them, apply a mild softmax to keep all options possible, then
// sample with a seeded RNG. Same seed → same picks for the entire week.

const crypto = require("crypto");

// SHA256(seedStr) → uint32 RNG state (mulberry32)
function seedFromString(s) {
  const hash = crypto.createHash("sha256").update(s).digest();
  return hash.readUInt32LE(0);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick one index from `weights` using rng (weighted). If all weights are 0,
// pick uniformly. Returns the index, NOT removing it from the array.
function weightedPick(rng, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// Pick `k` distinct indices from `weights` (1-based skip of index 0 if needed).
function weightedSampleDistinct(rng, weights, k, { skipZero = false } = {}) {
  const w = weights.slice();
  if (skipZero) w[0] = 0;
  const picked = [];
  for (let i = 0; i < k; i++) {
    const idx = weightedPick(rng, w);
    picked.push(idx);
    w[idx] = 0; // distinct
  }
  return picked;
}

// Bias unused weights upward a touch so they're not zero (softmax-lite).
function smooth(arr, floor = 0.5) {
  return arr.map(v => v + floor);
}

function sumSystems(systems, key) {
  const len = systems[0][key].length;
  const out = new Array(len).fill(0);
  for (const s of systems) {
    for (let i = 0; i < len; i++) out[i] += s[key][i];
  }
  return out;
}

// Each game gets its own seed so picks refresh on that game's draw days.
function synthesize({ systems, fourDSeed, totoSeed, fourDSets = 3, totoSets = 2, totoSize = 6 }) {
  const digitW  = smooth(sumSystems(systems, "digitWeights"));
  const numberW = smooth(sumSystems(systems, "numberWeights"));

  // ── 4D picks (seeded by next 4D draw date) ──
  const rng4 = mulberry32(seedFromString(fourDSeed));
  const fourD = [];
  const seen4 = new Set();
  let attempts = 0;
  while (fourD.length < fourDSets && attempts < fourDSets * 20) {
    attempts++;
    const d = [
      weightedPick(rng4, digitW),
      weightedPick(rng4, digitW),
      weightedPick(rng4, digitW),
      weightedPick(rng4, digitW),
    ].join("");
    if (!seen4.has(d)) { seen4.add(d); fourD.push(d); }
  }
  while (fourD.length < fourDSets) {
    const d = Math.floor(rng4() * 10000).toString().padStart(4, "0");
    if (!seen4.has(d)) { seen4.add(d); fourD.push(d); }
  }

  // ── TOTO picks (seeded by next TOTO draw date) ──
  const rngT = mulberry32(seedFromString(totoSeed));
  const toto = [];
  for (let s = 0; s < totoSets; s++) {
    const picks = weightedSampleDistinct(rngT, numberW, totoSize, { skipZero: true })
      .sort((a, b) => a - b);
    toto.push(picks);
  }

  return { fourD, toto };
}

module.exports = { synthesize, seedFromString, mulberry32 };
