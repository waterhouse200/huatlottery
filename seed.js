#!/usr/bin/env node
// ─── seed.js ── Generate realistic mock data for Huatlottery ─────────
const { getDb, initSchema, DB_PATH } = require("./db");
const fs = require("fs");

// ─── Helpers ─────────────────────────────────────────────────────────
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick `count` unique integers from [min, max] inclusive, returned sorted */
function pickUnique(count, min, max) {
  const set = new Set();
  while (set.size < count) set.add(randomInt(min, max));
  return [...set].sort((a, b) => a - b);
}

/** Generate a random 4-digit string "0000"–"9999" */
function rand4D() {
  return String(randomInt(0, 9999)).padStart(4, "0");
}

/** Generate N unique 4D numbers (no duplicates within a single draw) */
function randUnique4DSet(n) {
  const set = new Set();
  while (set.size < n) set.add(rand4D());
  return [...set];
}

/**
 * Singapore Pools draw schedule (simplified):
 *   TOTO  — Mon & Thu
 *   4D    — Wed, Sat, Sun
 * We generate backwards from a recent date.
 */
function subtractDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ─── TOTO Mock Data (55 draws) ───────────────────────────────────────
function generateTotoDraws(count = 55) {
  const draws = [];
  let drawNo = 4021;                              // latest draw number
  let drawDate = new Date("2026-03-19");           // latest draw date (Thu)

  // TOTO draws on Mon (1) and Thu (4)
  const totoWeekdays = [1, 4]; // 0=Sun … 6=Sat

  for (let i = 0; i < count; i++) {
    // Pick 7 unique numbers: first 6 = main, 7th = additional
    const all7 = pickUnique(7, 1, 49);
    const main6 = all7.slice(0, 6);
    const additional = all7[6];

    draws.push({
      draw_no: drawNo,
      draw_date: formatDate(drawDate),
      nums: main6,
      additional_num: additional,
    });

    // Step back to previous draw day
    drawNo--;
    let prev = new Date(drawDate);
    do {
      prev = subtractDays(prev, 1);
    } while (!totoWeekdays.includes(prev.getDay()));
    drawDate = prev;
  }

  return draws;
}

// ─── 4D Mock Data (60 draws) ─────────────────────────────────────────
function generateFourdDraws(count = 60) {
  const draws = [];
  let drawNo = 5612;                              // latest draw number
  let drawDate = new Date("2026-03-21");           // latest draw date (Sat)

  // 4D draws on Wed (3), Sat (6), Sun (0)
  const fourdWeekdays = [0, 3, 6];

  for (let i = 0; i < count; i++) {
    // All 23 numbers in one draw must be unique
    const all23 = randUnique4DSet(23);

    draws.push({
      draw_no: drawNo,
      draw_date: formatDate(drawDate),
      first_prize: all23[0],
      second_prize: all23[1],
      third_prize: all23[2],
      starter_prizes: all23.slice(3, 13),
      consolation_prizes: all23.slice(13, 23),
    });

    drawNo--;
    let prev = new Date(drawDate);
    do {
      prev = subtractDays(prev, 1);
    } while (!fourdWeekdays.includes(prev.getDay()));
    drawDate = prev;
  }

  return draws;
}

// ─── Execute Seed ────────────────────────────────────────────────────
function seed() {
  // Remove old database if it exists for a clean seed
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log("🗑  Removed old database");
  }

  const db = getDb();
  initSchema(db);
  console.log("📐 Schema created");

  // ── Insert TOTO draws ──────────────────────────────────────────────
  const totoDraws = generateTotoDraws(55);
  const insertToto = db.prepare(`
    INSERT INTO toto_draws (draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num)
    VALUES (@draw_no, @draw_date, @num1, @num2, @num3, @num4, @num5, @num6, @additional_num)
  `);

  const insertManyToto = db.transaction((rows) => {
    for (const row of rows) {
      insertToto.run({
        draw_no: row.draw_no,
        draw_date: row.draw_date,
        num1: row.nums[0],
        num2: row.nums[1],
        num3: row.nums[2],
        num4: row.nums[3],
        num5: row.nums[4],
        num6: row.nums[5],
        additional_num: row.additional_num,
      });
    }
  });

  insertManyToto(totoDraws);
  console.log(`🎰 Inserted ${totoDraws.length} TOTO draws  (draw #${totoDraws[totoDraws.length - 1].draw_no} → #${totoDraws[0].draw_no})`);

  // ── Insert 4D draws ────────────────────────────────────────────────
  const fourdDraws = generateFourdDraws(60);
  const insertFourd = db.prepare(`
    INSERT INTO fourd_draws (draw_no, draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes)
    VALUES (@draw_no, @draw_date, @first_prize, @second_prize, @third_prize, @starter_prizes, @consolation_prizes)
  `);

  const insertManyFourd = db.transaction((rows) => {
    for (const row of rows) {
      insertFourd.run({
        draw_no: row.draw_no,
        draw_date: row.draw_date,
        first_prize: row.first_prize,
        second_prize: row.second_prize,
        third_prize: row.third_prize,
        starter_prizes: JSON.stringify(row.starter_prizes),
        consolation_prizes: JSON.stringify(row.consolation_prizes),
      });
    }
  });

  insertManyFourd(fourdDraws);
  console.log(`🔢 Inserted ${fourdDraws.length} 4D draws   (draw #${fourdDraws[fourdDraws.length - 1].draw_no} → #${fourdDraws[0].draw_no})`);

  // ── Verification ───────────────────────────────────────────────────
  const totoCount = db.prepare("SELECT COUNT(*) AS cnt FROM toto_draws").get().cnt;
  const fourdCount = db.prepare("SELECT COUNT(*) AS cnt FROM fourd_draws").get().cnt;
  const latestToto = db.prepare("SELECT * FROM toto_draws ORDER BY draw_no DESC LIMIT 1").get();
  const latestFourd = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT 1").get();

  console.log("\n── Verification ──────────────────────────────────────");
  console.log(`   toto_draws  rows: ${totoCount}`);
  console.log(`   fourd_draws rows: ${fourdCount}`);
  console.log(`\n   Latest TOTO  #${latestToto.draw_no} (${latestToto.draw_date}): ${latestToto.num1} ${latestToto.num2} ${latestToto.num3} ${latestToto.num4} ${latestToto.num5} ${latestToto.num6} + ${latestToto.additional_num}`);
  console.log(`   Latest 4D   #${latestFourd.draw_no} (${latestFourd.draw_date}): 1st=${latestFourd.first_prize}  2nd=${latestFourd.second_prize}  3rd=${latestFourd.third_prize}`);
  console.log(`     Starters:    ${JSON.parse(latestFourd.starter_prizes).join(" ")}`);
  console.log(`     Consolation: ${JSON.parse(latestFourd.consolation_prizes).join(" ")}`);

  db.close();
  console.log("\n✅ Database seeded successfully!\n");
}

seed();
