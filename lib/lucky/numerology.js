// ─── lib/lucky/numerology.js ── Western numerology votes ─────────────
//
// Returns vote weights for digits 0-9 and numbers 1-49, plus the
// human-readable "facts" the synthesizer can quote in the reading.

function sumDigits(n) {
  return String(n).split("").reduce((a, c) => a + parseInt(c, 10), 0);
}

function reduceToSingle(n) {
  // Master numbers 11, 22, 33 traditionally preserved; we still reduce
  // for picking digits, but keep the master flag for the reading.
  let x = n;
  while (x > 9) x = sumDigits(x);
  return x;
}

// "1990-03-15" → { y, m, d }
function parseBirthday(birthday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (!m) throw new Error(`Invalid birthday: ${birthday}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function compute(birthday) {
  const { y, m, d } = parseBirthday(birthday);

  const allDigits = `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  const lifePathRaw = sumDigits(allDigits);
  const lifePath = reduceToSingle(lifePathRaw);
  const birthdayNumber = reduceToSingle(d);
  const expression = reduceToSingle(sumDigits(`${m}${d}`)); // simplified (no name)
  const masterNumber = [11, 22, 33].includes(lifePathRaw) ? lifePathRaw : null;

  // Digit votes: emphasize life-path, birthday digit, and the raw DDMM digits.
  const digitWeights = new Array(10).fill(0);
  digitWeights[lifePath] += 3;
  digitWeights[birthdayNumber % 10] += 2;
  digitWeights[expression] += 2;
  // Birthday digits themselves
  for (const c of `${String(d).padStart(2, "0")}${String(m).padStart(2, "0")}`) {
    digitWeights[+c] += 1;
  }

  // Number votes (1-49): life-path multiples + birthday-derived numbers.
  const numberWeights = new Array(50).fill(0); // index 0 unused
  const add = (n, w) => { if (n >= 1 && n <= 49) numberWeights[n] += w; };
  add(lifePath, 4);
  add(lifePath * 7, 2);
  add(d, 3);
  add(m, 2);
  add((y % 49) || 49, 1);
  add(expression, 2);
  add(birthdayNumber, 2);
  add(((d + m) % 49) || 49, 1);
  add(((d * m) % 49) || 49, 1);

  return {
    name: "numerology",
    facts: {
      lifePath,
      lifePathRaw,
      birthdayNumber,
      expression,
      masterNumber,
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute, reduceToSingle, sumDigits };
