"""Side-by-side: full 6-main-number archive vs strict 6/49 era (post-9-Oct-2014).

The hot/cold rule's +7% lift on the full archive might be an artifact of the
6/45 era (numbers 46-49 didn't exist). This script re-runs the key rules on
the strict 6/49 era only and reports whether the signal survives.

Usage:  .venv/bin/python -m analysis.compare_eras
"""

from __future__ import annotations

import pandas as pd

from analysis import data, backtest
from analysis.rules import hot_cold, gap_due, set_filters


def header(title: str) -> None:
    print()
    print("═" * 100)
    print(f"  {title}")
    print("═" * 100)


def run_rules(df: pd.DataFrame, label: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (elim_table_df, filter_table_df)."""
    # Number-level rules
    elim_rows = []
    for window in [50, 100, 200]:
        for mode in ["cold", "hot"]:
            r = backtest.walk_forward_eliminate(
                df, hot_cold.compute, f"hot_cold(w={window},{mode})",
                warmup=100, eliminate_n=24, window=window, mode=mode,
            )
            elim_rows.append(r.as_row())
    for mode in ["due", "recent"]:
        r = backtest.walk_forward_eliminate(
            df, gap_due.compute, f"gap_due({mode})",
            warmup=100, eliminate_n=24, mode=mode,
        )
        elim_rows.append(r.as_row())

    # Set-level filters
    filt_rows = []
    for (lo, hi) in [(0.05, 0.95), (0.10, 0.90)]:
        r = backtest.walk_forward_filter(
            df, set_filters.sum_range_filter,
            f"sum_range({int(lo*100)}-{int(hi*100)}%)",
            warmup=100, lo_pct=lo, hi_pct=hi,
        )
        filt_rows.append(r.as_row())
    for me in [1, 2]:
        r = backtest.walk_forward_filter(
            df, set_filters.even_odd_filter,
            f"even_odd(min={me})",
            warmup=100, min_each=me,
        )
        filt_rows.append(r.as_row())
    for mpd in [3, 4]:
        r = backtest.walk_forward_filter(
            df, set_filters.decade_spread_filter,
            f"decade_max{mpd}",
            warmup=100, max_per_decade=mpd,
        )
        filt_rows.append(r.as_row())
    for mc in [2, 3]:
        r = backtest.walk_forward_filter(
            df, set_filters.consecutive_filter,
            f"consec(max{mc})",
            warmup=100, max_consecutive=mc,
        )
        filt_rows.append(r.as_row())

    return pd.DataFrame(elim_rows), pd.DataFrame(filt_rows)


def main() -> None:
    toto = data.load_toto()
    full = backtest.filter_six_main(toto)
    strict = backtest.filter_strict_649(toto)

    print(f"Full archive (any 6-main format): {len(full):>5} draws")
    print(f"Strict 6/49 era (post-9-Oct-2014): {len(strict):>5} draws")

    header(f"FULL ARCHIVE: number-level elimination ({len(full)} draws)")
    elim_full, filt_full = run_rules(full, "full")
    print(elim_full.to_string(index=False))
    print()
    print(f"FULL ARCHIVE: set-level filters")
    print(filt_full.to_string(index=False))

    header(f"STRICT 6/49 era only: number-level elimination ({len(strict)} draws)")
    elim_strict, filt_strict = run_rules(strict, "strict")
    print(elim_strict.to_string(index=False))
    print()
    print(f"STRICT 6/49 era: set-level filters")
    print(filt_strict.to_string(index=False))

    # ── Diff for hot/cold lifts ──
    header("Did hot/cold's signal survive the era filter?")
    print()
    merged = elim_full.merge(
        elim_strict, on="rule", suffixes=("_full", "_strict")
    )
    cols = ["rule", "lift_%_full", "lift_%_strict", "p_full", "p_strict",
            "p<0.05?_full", "p<0.05?_strict"]
    print(merged[cols].to_string(index=False))

    print()
    print("─" * 100)
    print("Read the 'lift_%_strict' column. If it stays positive and the p-value < 0.05,")
    print("the rule has real signal. If it collapses near zero, the lift was a 6/45-era artifact.")
    print("─" * 100)


if __name__ == "__main__":
    main()
