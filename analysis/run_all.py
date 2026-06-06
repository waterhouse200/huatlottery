"""Run all rules walk-forward and produce a comparison report.

Usage:
  .venv/bin/python -m analysis.run_all

This is the 'rigid testing' run. Two evaluation modes shown side by side:
  1. Number-level elimination: how many actual winners survived a rule's
     elimination of N numbers? Compared to random.
  2. Set-level filter: what % of historical winning sets pass the filter?

p-values are one-sample t-test against the random baseline (number-level only).
We use ALL 6/49-era draws (post-Oct 2014) to avoid the 6/45-era data quirk.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from analysis import data, backtest
from analysis.rules import hot_cold, gap_due, set_filters


def section(title: str) -> None:
    print()
    print("═" * 90)
    print(f"  {title}")
    print("═" * 90)


def main() -> None:
    toto = data.load_toto()
    toto_649 = backtest.filter_649(toto)
    n_total = len(toto_649)
    print(f"Working with {n_total} 6/49-format TOTO draws (warmup=200 means we evaluate {n_total-200} of them)")

    # ── A. Number-level elimination ──────────────────────────────
    section("A. Number-level elimination — eliminate 24 numbers from 49 (keep 25)")
    print("Random baseline survivor mean ≈ 6 × 25/49 ≈ 3.06 (of 6 winning numbers)")
    print()

    elim_results = []
    elim_n = 24

    # Hot/cold across multiple windows + both modes
    for window in [20, 50, 100, 200, 500]:
        for mode in ["cold", "hot"]:
            r = backtest.walk_forward_eliminate(
                toto_649, hot_cold.compute, f"hot_cold(w={window}, mode={mode})",
                warmup=200, eliminate_n=elim_n,
                window=window, mode=mode,
            )
            elim_results.append(r)

    # Gap-based
    for mode in ["due", "recent"]:
        r = backtest.walk_forward_eliminate(
            toto_649, gap_due.compute, f"gap_due(mode={mode})",
            warmup=200, eliminate_n=elim_n,
            mode=mode,
        )
        elim_results.append(r)

    backtest.print_elim_table(elim_results)

    # ── B. Set-level filter ──────────────────────────────────────
    section("B. Set-level filter — % of historical winning sets that pass")
    print("If pass_rate ≈ 100%, we can safely apply this filter (no winner lost)")
    print()

    filt_results = []

    # Sum range — different quantile widths
    for (lo, hi) in [(0.10, 0.90), (0.20, 0.80), (0.05, 0.95)]:
        r = backtest.walk_forward_filter(
            toto_649, set_filters.sum_range_filter,
            f"sum_range({int(lo*100)}-{int(hi*100)}%ile)",
            warmup=200, lo_pct=lo, hi_pct=hi,
        )
        filt_results.append(r)

    # Even/odd
    for me in [1, 2]:
        r = backtest.walk_forward_filter(
            toto_649, set_filters.even_odd_filter,
            f"even_odd(min_each={me})",
            warmup=200, min_each=me,
        )
        filt_results.append(r)

    # Decade spread
    for mpd in [3, 4]:
        r = backtest.walk_forward_filter(
            toto_649, set_filters.decade_spread_filter,
            f"decade_spread(max_per={mpd})",
            warmup=200, max_per_decade=mpd,
        )
        filt_results.append(r)

    # Consecutive
    for mc in [2, 3]:
        r = backtest.walk_forward_filter(
            toto_649, set_filters.consecutive_filter,
            f"consecutive(max={mc})",
            warmup=200, max_consecutive=mc,
        )
        filt_results.append(r)

    backtest.print_filter_table(filt_results)

    # ── C. Summary verdict ──────────────────────────────────────
    section("C. Verdict (rules sorted by significance)")
    sig_rules = sorted(
        elim_results, key=lambda r: (r.p_value, -r.lift_pct)
    )
    print("\nNumber-level rules ranked by p-value:")
    print()
    for r in sig_rules[:6]:
        marker = "✓" if r.significant else "·"
        print(f"  {marker}  {r.rule_name:<35}  lift {r.lift_pct:+6.2f}%   p={r.p_value:.4g}")

    print("\nSet-level filters ranked by pass rate:")
    print()
    for r in sorted(filt_results, key=lambda r: -r.pass_rate)[:6]:
        flag = "✓" if r.pass_rate >= 0.95 else "·"
        print(f"  {flag}  {r.rule_name:<35}  pass {r.pass_rate*100:5.1f}%   params={r.rule_kwargs}")


if __name__ == "__main__":
    main()
