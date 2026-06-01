// ─── lib/lucky/reading.js ── Weekly narrative (EN / 中文) ───────────

const ELEMENT_EN = { "木": "Wood", "火": "Fire", "土": "Earth", "金": "Metal", "水": "Water" };

const TONE = {
  Wood:  { en: "growth and new beginnings", zh: "成长与新的开始" },
  Fire:  { en: "passion and visibility",    zh: "热情与展现" },
  Earth: { en: "stability and patience",    zh: "稳定与耐心" },
  Metal: { en: "discipline and clarity",    zh: "纪律与清晰" },
  Water: { en: "intuition and adaptability",zh: "直觉与灵活" },
};

function buildEN(facts) {
  const { numerology, zodiacWestern, zodiacChinese, bazi, qimen } = facts;
  const el = ELEMENT_EN[bazi.dayMasterElement] || "Earth";
  const tone = (TONE[el] || TONE.Earth).en;
  const moonNote = zodiacWestern.moonApproximated
    ? " (Moon sign approximated — add birth time for a sharper read)"
    : "";

  return [
    `Your week is shaped by ${bazi.dayMasterEn} energy — favoring ${tone}.`,
    `As a ${zodiacChinese.animalEn} (${zodiacChinese.dayMasterElement} day-master) with ${zodiacWestern.sun} Sun and ${zodiacWestern.moon} Moon${moonNote}, ` +
      `you're sitting in the ${qimen.palaceName} palace (${qimen.direction}, ${qimen.element}) this week.`,
    `Life-path ${numerology.lifePath} amplifies the digit ${numerology.lifePath} and its multiples. ` +
      `These picks blend all five systems — buy what resonates, leave the rest.`,
  ].join(" ");
}

function buildZH(facts) {
  const { numerology, zodiacWestern, zodiacChinese, bazi, qimen } = facts;
  const tone = (TONE[ELEMENT_EN[bazi.dayMasterElement]] || TONE.Earth).zh;
  const moonNote = zodiacWestern.moonApproximated ? "（月座为概略估算，输入出生时辰可获得更精准的解读）" : "";

  return [
    `本周由您的日主【${bazi.dayMaster}（${bazi.dayMasterEn}）】所主导，宜${tone}。`,
    `您属${zodiacChinese.animal}，太阳${zodiacWestern.sun}，月亮${zodiacWestern.moon}${moonNote}，本周落入${qimen.palaceNameZh}宫（${qimen.direction}，${qimen.element}）。`,
    `生命数字 ${numerology.lifePath} 加强了数字 ${numerology.lifePath} 的能量。以下号码综合五大体系所得，宁可参考、不必尽信。`,
  ].join(" ");
}

function buildReading(facts, lang) {
  return lang === "zh" ? buildZH(facts) : buildEN(facts);
}

module.exports = { buildReading };
