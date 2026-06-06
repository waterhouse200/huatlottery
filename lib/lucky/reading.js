// ─── lib/lucky/reading.js ── Weekly narrative (EN / 中文) ───────────
//
// Headline now keyed on the interaction between user's natal day master
// and THIS WEEK'S dominant element (from transits.js). So the reading
// genuinely shifts week-to-week as the calendar moves.

const ELEMENT_EN = { "木": "Wood", "火": "Fire", "土": "Earth", "金": "Metal", "水": "Water" };

// Headline (1 line, plain English) + Summary (1-2 sentences, no jargon)
// keyed on the relationship between week's element and natal day master.
const HEADLINE_BY_REL = {
  resource: { en: "A supportive week.",                   zh: "顺势之周。" },
  peer:     { en: "A strong week — your energy aligns.",  zh: "气场加持的一周。" },
  wealth:   { en: "A profitable week.",                   zh: "财运利好的一周。" },
  output:   { en: "An expressive week.",                  zh: "宣泄表达的一周。" },
  officer:  { en: "A testing week — stay disciplined.",   zh: "压力之周，宜守规。" },
  neutral:  { en: "A balanced week.",                     zh: "平和之周。" },
};

// Plain-English "why" — no astrology jargon, just guidance. 3 sentences:
// (1) what the week is like, (2) what to lean into, (3) what to watch.
const SUMMARY_BY_REL = {
  resource: {
    en: "This week's energy is on your side — momentum favours you. Act on the plans you've been putting off: start the project, send the message, follow up on the conversation that stalled. Small steady actions compound now; trust your instincts on the bigger calls.",
    zh: "本周能量顺向您而来，势头利好。是采取行动的好时机——开启一直拖延的项目，发送那条搁置的消息，跟进停滞的对话。此时小行动累积成果；在重大决定上请相信您的直觉。",
  },
  peer: {
    en: "Your natural rhythm syncs with the week, so expect more decisiveness, visibility, and energy. This is when leadership comes easily — take charge, propose the change, set the boundary you've been avoiding. Pick the one big move that matters and execute well; don't burn out by saying yes to everything.",
    zh: "您的节奏与本周能量同步，决断力、影响力、能量都会增强。三者合一时，领导力自然显现——主动出击、提出改变、划下早该划的界限。挑选一件真正重要的大事，全力完成；切勿因贪多而过度承诺。",
  },
  wealth: {
    en: "The week tilts financial momentum toward you. Good time to negotiate, close pending deals, ask for what you want, or place small thoughtful bets. Be active rather than passive — this week rewards deliberate moves, not impulsive splurges.",
    zh: "本周构筑财运势头。是谈判、收尾旧账、争取应得之事、或小注精准下手的好时机。主动出击胜于被动等待——本周回报的是深思熟虑的行动，而非冲动消费。",
  },
  output: {
    en: "Creativity and generosity flow strongly this week — but so does fatigue by the weekend. Use the burst for creative projects, important conversations, or expressing things you've been holding back. Schedule some downtime now; if you don't pace, you'll run out of steam right when something good appears.",
    zh: "本周创意与慷慨同流，但周末易感疲倦。将这股能量用于创作、重要对话、或表达积压已久的情感。请提前安排休息时间——若不节奏均衡，能量会在好事临门时刚好耗尽。",
  },
  officer: {
    en: "The week applies friction. Expect delays, pushback, and small obstacles — don't take them personally, the rhythm is just off this round. Avoid big financial decisions and new commitments; instead finish what you've already started, rest well, and let the week refine you. Whatever survives this week is real.",
    zh: "本周阻力较大。延迟、反对、小麻烦会冒出来——别放在心上，只是节奏暂时不顺。避免重大财务决定与新承诺；专注完成进行中的事、好好休息、让本周锤炼您。能熬过本周的，便是真实。",
  },
  neutral: {
    en: "No strong tides this week — neither boosted nor blocked. A reading-the-room week, not an acting one: use the calm to plan, study patterns, listen before moving. Light bets only if you must play; the lack of strong signal is itself useful information.",
    zh: "本周能量平和，无明显涨落。是静观之周，而非行动之周——利用安静的时段计划、研究规律、聆听他人。若要购彩，请小注；无强信号本身也是有用的信号。",
  },
};

function buildReading(facts, lang) {
  const isZh = lang === "zh";
  const t = facts.transits || {};
  const rel = t.relationship || "neutral";

  const headlineBank = HEADLINE_BY_REL[rel] || HEADLINE_BY_REL.neutral;
  const headline = isZh ? headlineBank.zh : headlineBank.en;

  const summaryBank = SUMMARY_BY_REL[rel] || SUMMARY_BY_REL.neutral;
  const summary = isZh ? summaryBank.zh : summaryBank.en;

  // Sections are kept for an optional "See full chart" power-user toggle
  // — they are not surfaced by default in the simplified UI.
  const sections = [];

  // ── 2. Your Natal Day Master (fixed) ──
  sections.push({
    label: isZh ? "您的命主" : "Your natal element",
    text: isZh
      ? `日主【${facts.bazi.dayMaster}】（${facts.bazi.dayMasterEn} / ${ELEMENT_EN[facts.bazi.dayMasterElement] || ""}）。`
      : `Day master ${facts.bazi.dayMasterEn} (${ELEMENT_EN[facts.bazi.dayMasterElement] || ""}).`,
  });

  // ── 3. Chinese Zodiac (fixed at birth) ──
  const zc = facts.zodiacChinese;
  sections.push({
    label: isZh ? "生肖" : "Chinese zodiac",
    text: isZh
      ? `${zc.yearElement}${zc.animal}（${zc.yearGanZhi}年）。`
      : `${zc.yearElementEn} ${zc.animalEn} (${zc.yearGanZhi} year).`,
  });

  // ── 4. Western Sun (fixed) ──
  sections.push({
    label: isZh ? "西方星座" : "Western astrology",
    text: isZh
      ? `太阳 ${facts.zodiacWestern.sun}（${facts.zodiacWestern.sunElement}）。`
      : `Sun in ${facts.zodiacWestern.sun} (${facts.zodiacWestern.sunElement} element).`,
  });

  // ── 5. Your Nine Palace (fixed) ──
  const qm = facts.qimen;
  sections.push({
    label: isZh ? "九宫" : "Nine Palace",
    text: isZh
      ? `日家九星 ${qm.palace}（${qm.colorZh}${qm.element}）— ${qm.position}宫。`
      : `Day Nine Star ${qm.palace} (${qm.elementEn}) — ${qm.positionEn} palace.`,
  });

  // ── 6. Numerology (fixed) ──
  const num = facts.numerology;
  sections.push({
    label: isZh ? "生命数字" : "Numerology",
    text: isZh
      ? `生命数字 ${num.lifePath}${num.masterNumber ? `（${num.masterNumber} 主导数）` : ""}。`
      : `Life Path ${num.lifePath}${num.masterNumber ? ` (master ${num.masterNumber})` : ""}.`,
  });

  const text = `${headline} ${summary}`;

  return { headline, summary, sections, text, relationship: rel, favorable: t.favorable };
}

module.exports = { buildReading };
