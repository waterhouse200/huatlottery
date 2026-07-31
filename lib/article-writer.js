// ─── lib/article-writer.js ── Turn an official announcement into an article ─
//
// Two writers behind one interface:
//
//   anthropic  Rewrites the announcement in our own words using the Claude API
//              (claude-opus-5). Preferred — reads naturally and varies between
//              articles instead of filling in the same template every time.
//
//   template   Deterministic fallback. Runs when ANTHROPIC_API_KEY is absent or
//              the API call fails, so a scheduled run always produces something
//              publishable and the section never goes stale waiting on a key.
//
// Whichever writer runs, the result goes through lib/sanitizer.js before it can
// be published: the prompt below ASKS for no purchase language and exact
// figures, the sanitizer GUARANTEES it.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5";

// The article shape both writers produce. Given to the API as a JSON schema so
// the model must return these fields — no parsing prose for headings.
const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "SEO page title, 50-60 characters, ending with ' | Huatlottery'" },
    h1: { type: "string", description: "Page heading, 40-60 characters. Must read differently from the title, not a copy of it." },
    meta_desc: { type: "string", description: "Meta description, 140-158 characters, factual." },
    lead: { type: "string", description: "One-sentence standfirst summarising what was announced." },
    body_html: {
      type: "string",
      description:
        "Article body as simple HTML: <p> paragraphs and at most two <h2> subheadings. 180-260 words. No links, no lists of prizes formatted as tables, no inline styles.",
    },
  },
  required: ["title", "h1", "meta_desc", "lead", "body_html"],
  additionalProperties: false,
};

const SYSTEM = `You write short, factual news items for Huatlottery, a results-and-statistics site covering Singapore and Malaysia lottery draws.

You are given the facts of an announcement an operator published on its own website. Report what was announced, in your own words.

Hard rules:
1. Every figure you state must appear in the facts you were given. Never estimate, round beyond what is given, convert currencies, or introduce a number from your own knowledge. If a fact is absent, do not mention it.
2. Never tell the reader to buy, bet, play, stake, enter, or claim anything. Do not mention where to buy, how to enter, apps, outlets, promotions or deadlines. You are reporting an announcement, not advertising it.
3. Do not imply any number, date or pattern makes a win more likely. These are chance games and past results do not predict future draws.
4. Use the assigned keywords naturally — the primary once in the title, once in the H1, and once or twice in the body. Do not repeat them beyond that. Copy that is stuffed with keywords will be rejected.
5. Plain, concrete news writing. No hype ("massive", "life-changing", "don't miss"), no second-person address, no rhetorical questions.
6. State clearly when an amount is an estimate rather than a confirmed prize.`;

// The prompt is built entirely from stored facts — never from raw page HTML —
// so nothing promotional from the source can reach the model in the first place.
function buildPrompt(announcement, facts, keywords) {
  const prizeLines = (facts.prizes || []).map((p) => `- ${p.label}: ${p.display}`).join("\n") || "- (no prize figures published)";
  return `Official announcement to report:

Source: ${announcement.source_url}
Operator headline: ${announcement.official_title}
Game: ${facts.game}
Region: ${facts.region}
Draw date: ${facts.draw_date || "not stated in the announcement"}
These amounts are ${facts.estimated ? "ESTIMATES published ahead of the draw" : "confirmed figures"}.

Published amounts (these are the ONLY figures you may state):
${prizeLines}

Keywords for this article:
- primary (use in title, H1, and once or twice in the body): "${keywords.primary}"
- secondary (use at most once each, only where they fit naturally): ${keywords.secondary.map((k) => `"${k}"`).join(", ") || "none"}

Write the article.`;
}

async function writeWithAnthropic(announcement, facts, keywords) {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000, // headroom: on this model max_tokens covers thinking plus the reply
    system: SYSTEM,
    output_config: {
      effort: "low", // a short factual rewrite — no need to pay for deep reasoning
      format: { type: "json_schema", schema: ARTICLE_SCHEMA },
    },
    messages: [{ role: "user", content: buildPrompt(announcement, facts, keywords) }],
  });

  if (message.stop_reason === "refusal") throw new Error("model declined to write this announcement");
  const text = (message.content || []).find((b) => b.type === "text");
  if (!text) throw new Error("no text block in response");
  const article = JSON.parse(text.text);
  return { ...article, writer: `anthropic:${MODEL}` };
}

// ─── Deterministic fallback ─────────────────────────────────────────
// Varies its phrasing by announcement id so consecutive articles don't read
// identically, and states only the figures it was handed.
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// Keywords are stored lowercase for matching, but a naive title-case leaves
// "4d"/"toto" looking wrong in a heading — \b\w matches the digit in "4d" and
// never reaches the letter. Capitalise words, then restore the game tokens.
const GAME_TOKENS = { "4d": "4D", "3d": "3D", "6d": "6D", "5d": "5D", toto: "TOTO", mgold: "mGold" };
function displayKeyword(kw) {
  return kw
    .split(/\s+/)
    .map((w) => {
      const bare = w.toLowerCase();
      if (GAME_TOKENS[bare]) return GAME_TOKENS[bare];
      // compound like "1+3d" — fix the game token inside it
      const compound = bare.replace(/\b(\d?\+?)(\d)d\b/, (m, pre, n) => `${pre}${n}D`);
      if (compound !== bare) return compound;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function writeWithTemplate(announcement, facts, keywords) {
  const seed = announcement.id || 0;
  const g = facts.game;
  const when = facts.draw_date ? `the ${facts.draw_date} draw` : "the coming draw";
  const est = facts.estimated ? "estimated" : "confirmed";
  const prizes = facts.prizes || [];
  const top = prizes[0];

  const opener = pick([
    `${g} has published ${est} prize figures for ${when}.`,
    `Figures for ${when} have been published by ${g}.`,
    `${g} has set out what is on offer at ${when}.`,
  ], seed);

  // Prize labels are printed by the operator with the game name baked in
  // ("Magnum 4D Jackpot 1"). Listing several verbatim repeats that name in
  // every clause, which reads as stuffing and fails the density gate — the
  // surrounding sentence has already established whose prizes these are.
  const shortLabel = (label) => {
    const stripped = label.replace(new RegExp(`^${g.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*`, "i"), "").trim();
    return (stripped || label).toLowerCase();
  };

  const headline = top
    ? `The ${shortLabel(top.label)} stands at ${top.display}.`
    : `The operator confirmed the draw date without publishing prize figures.`;

  const rest = prizes.slice(1);
  const restPara = rest.length
    ? `<p>Alongside it, ${rest.map((p) => `the ${shortLabel(p.label)} is listed at ${p.display}`).join(", ")}.</p>`
    : "";

  const caveat = facts.estimated
    ? `<p>Amounts published before a draw are estimates. The figure confirmed after the draw can differ, because prize pools move with the number of entries received and with whether a top prize was won at the previous draw.</p>`
    : `<p>These are the figures as published by the operator for this draw.</p>`;

  const context = `<p>${displayKeyword(keywords.primary)} figures are published by the operator ahead of each draw and change from one draw to the next. Huatlottery records them as they appear so the movement between draws can be followed over time.</p>`;

  const chance = `<p>Draw outcomes are determined by chance. Past results and published prize levels say nothing about which numbers will be drawn next.</p>`;

  return {
    title: `${displayKeyword(keywords.primary)} — ${facts.draw_date || "Latest Figures"} | Huatlottery`,
    h1: `${g} ${est} prize figures${facts.draw_date ? ` for ${facts.draw_date}` : ""}`,
    meta_desc: `${g} has published ${est} prize figures${facts.draw_date ? ` for the ${facts.draw_date} draw` : ""}${top ? `, with the ${shortLabel(top.label)} at ${top.display}` : ""}. Reported from the operator's own announcement.`,
    lead: `${opener} ${headline}`,
    // The lead is rendered above the body, so the body must not repeat it.
    body_html: `${restPara}${caveat}${context}${chance}`,
    writer: "template",
  };
}

// Try the API, fall back to the template on any failure. Never throws.
async function write(announcement, facts, keywords) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await writeWithAnthropic(announcement, facts, keywords);
    } catch (err) {
      console.log(`  [writer] Claude API unavailable (${err.message}) — using template`);
    }
  }
  return writeWithTemplate(announcement, facts, keywords);
}

module.exports = { write, writeWithAnthropic, writeWithTemplate, ARTICLE_SCHEMA, SYSTEM, MODEL };
