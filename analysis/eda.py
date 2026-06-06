"""Exploratory data analysis for shared review.

Run: .venv/bin/python -m analysis.eda

Prints a series of findings about the TOTO + 4D data. Designed to be
read and discussed before deciding what to eliminate or how to filter.
No predictions, no eliminations — just an honest look at the data.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from analysis import data, features


def header(title: str) -> None:
    print()
    print("═" * 70)
    print(f"  {title}")
    print("═" * 70)


def section(title: str) -> None:
    print()
    print(f"── {title} ──")


def main() -> None:
    toto  = data.load_toto()
    fourd = data.load_fourd()

    # ── 1. Basic dataset overview ────────────────────────────────
    header("Dataset overview")
    print(data.summary())

    # ── 2. TOTO all-time frequency ───────────────────────────────
    header("TOTO — All-time number frequency (full archive)")

    # Only count draws in current 6/49 format for a fair comparison
    toto_649 = toto[toto["num6"].notna()].copy()
    n_draws_649 = len(toto_649)
    expected_per_number = n_draws_649 * 6 / 49

    # Count appearances per number
    counts = {n: 0 for n in range(1, 50)}
    for nums in toto_649["numbers"]:
        for n in nums:
            counts[n] += 1
    freq = pd.Series(counts).sort_values(ascending=False)

    section(f"Across {n_draws_649} 6/49-format draws — "
            f"expected ~{expected_per_number:.0f} per number if perfectly uniform")

    print("\n  Top 10 most frequent:")
    for i, (n, c) in enumerate(freq.head(10).items(), 1):
        diff = c - expected_per_number
        bar = "█" * int(c / 30)
        print(f"    {i:>2}. #{n:>2}  {c:>3} times  {bar} "
              f"({diff:+.0f} vs expected)")

    print("\n  Top 10 least frequent:")
    for i, (n, c) in enumerate(freq.tail(10).items(), 1):
        diff = c - expected_per_number
        bar = "█" * int(c / 30)
        print(f"    {i:>2}. #{n:>2}  {c:>3} times  {bar} "
              f"({diff:+.0f} vs expected)")

    # Chi-square test: is the distribution actually uniform?
    from scipy import stats as sps
    observed = freq.values
    expected = np.full_like(observed, expected_per_number, dtype=float)
    chi2, p = sps.chisquare(observed, expected)
    section("Is the lottery actually random? Chi-square test of uniformity")
    print(f"  chi-square statistic: {chi2:.2f}")
    print(f"  p-value:              {p:.4f}")
    if p < 0.05:
        print(f"  → p < 0.05: distribution DEVIATES from uniform "
              f"(but lottery 6/49 is designed to be random — this is data noise)")
    else:
        print(f"  → p ≥ 0.05: cannot reject uniformity. "
              f"All numbers appear roughly as often as random chance predicts.")

    # ── 3. The gambler's question ────────────────────────────────
    header("Gambler's question: 'Should I play the hot or cold numbers?'")

    section("If you'd played the 6 ALL-TIME HOTTEST numbers every draw...")
    top6 = set(freq.head(6).index.tolist())
    hits_per_draw = []
    for nums in toto_649["numbers"]:
        hits_per_draw.append(len(set(nums) & top6))
    hits_per_draw = np.array(hits_per_draw)
    baseline = 6 * 6 / 49   # if you picked 6 random numbers
    print(f"  Average match per draw: {hits_per_draw.mean():.3f}  (out of 6)")
    print(f"  Random baseline:        {baseline:.3f}")
    print(f"  Lift over random:       {hits_per_draw.mean() - baseline:+.3f} "
          f"({(hits_per_draw.mean() - baseline) / baseline * 100:+.1f}%)")

    section("If you'd played the 6 ALL-TIME COLDEST numbers every draw...")
    bot6 = set(freq.tail(6).index.tolist())
    hits_per_draw_c = []
    for nums in toto_649["numbers"]:
        hits_per_draw_c.append(len(set(nums) & bot6))
    hits_per_draw_c = np.array(hits_per_draw_c)
    print(f"  Average match per draw: {hits_per_draw_c.mean():.3f}  (out of 6)")
    print(f"  Random baseline:        {baseline:.3f}")
    print(f"  Lift over random:       {hits_per_draw_c.mean() - baseline:+.3f} "
          f"({(hits_per_draw_c.mean() - baseline) / baseline * 100:+.1f}%)")

    print("\n  ⚠  Note: 'all-time' is leaky — uses future data to identify hot/cold.")
    print("     A real walk-forward backtest uses only past draws. See backtest.py.")

    # ── 4. TOTO sum distribution ─────────────────────────────────
    toto_feat = features.add_toto_features(toto_649)
    header("TOTO sum (sum of 6 winning numbers) — distribution")
    s = toto_feat["sum"]
    section(f"min={s.min()}  q25={s.quantile(.25):.0f}  median={s.median():.0f}  "
            f"q75={s.quantile(.75):.0f}  max={s.max()}  mean={s.mean():.1f}")
    print("\n  Histogram (each row = 10 sums):")
    for lo in range(0, 301, 25):
        hi = lo + 24
        count = int(((s >= lo) & (s <= hi)).sum())
        bar = "▇" * int(count / 5)
        print(f"    sum {lo:>3}–{hi:<3}: {bar} {count}")

    # ── 5. Even/Odd split ────────────────────────────────────────
    header("TOTO even/odd split per draw (6 numbers each)")
    eo = toto_feat["even_count"].value_counts().sort_index()
    print()
    for k, v in eo.items():
        bar = "▇" * int(v / 30)
        pct = v / len(toto_feat) * 100
        print(f"  {k}E/{6-k}O:  {bar} {v}  ({pct:.1f}%)")

    # ── 6. Day-of-week (where dates exist) ───────────────────────
    header("TOTO draws by day of week (Mon = TOTO draw day, Thu = other)")
    dated = toto_feat.dropna(subset=["dow"])
    dow_names = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}
    by_dow = dated["dow"].astype("Int64").map(dow_names).value_counts()
    print()
    for k, v in by_dow.items():
        bar = "▇" * int(v / 30)
        print(f"  {k}: {bar} {v}")

    # ── 7. 4D headline patterns ──────────────────────────────────
    header("4D — repeat-digit patterns in 1st prize")
    fd_feat = features.add_fourd_features(fourd)
    cls = fd_feat["first_prize_class"].value_counts()
    print()
    for k in ["quad", "triple", "double", "none"]:
        v = int(cls.get(k, 0))
        pct = v / len(fd_feat) * 100
        bar = "▇" * int(v / 50)
        print(f"  1st prize is {k:>6}:  {bar} {v}  ({pct:.1f}%)")

    print()
    print("─" * 70)
    print("End of EDA. Open analysis/eda.py to tweak or add findings.")
    print("─" * 70)


if __name__ == "__main__":
    main()
