"""Wide sweep: 24+ rules tested rigorously on strict 6/49 era + 4D.

Bonferroni correction applied. With N tests at family-wise alpha=0.05,
each individual test must clear p < 0.05/N to be considered significant.

Usage:  .venv/bin/python -m analysis.sweep
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

from analysis import data, backtest
from analysis.rules import hot_cold, gap_due, set_filters, extra_rules, fourd as fourd_rules


def header(title: str) -> None:
    print()
    print("═" * 110)
    print(f"  {title}")
    print("═" * 110)


def run_toto_sweep(strict_649: pd.DataFrame) -> tuple[list, list]:
    """Returns (elim_results, filter_results)."""
    elim: list[backtest.EliminationResult] = []

    # Hot/cold sweep
    for window in [20, 50, 100, 200, 500]:
        for mode in ["cold", "hot"]:
            elim.append(backtest.walk_forward_eliminate(
                strict_649, hot_cold.compute, f"hot_cold(w={window},{mode})",
                warmup=100, eliminate_n=24, window=window, mode=mode,
            ))

    # Gap-due
    for mode in ["due", "recent"]:
        elim.append(backtest.walk_forward_eliminate(
            strict_649, gap_due.compute, f"gap_due({mode})",
            warmup=100, eliminate_n=24, mode=mode,
        ))

    # Last-digit clustering
    for w in [50, 100, 200]:
        elim.append(backtest.walk_forward_eliminate(
            strict_649, extra_rules.last_digit_score, f"last_digit(w={w})",
            warmup=100, eliminate_n=24, window=w,
        ))

    # Repeat-from-previous
    for mode in ["eliminate_repeat", "eliminate_non_repeat"]:
        elim.append(backtest.walk_forward_eliminate(
            strict_649, extra_rules.repeat_from_previous_score,
            f"repeat_prev({mode.split('_',1)[1]})",
            warmup=100, eliminate_n=24, mode=mode,
        ))

    # Prime / composite
    for mode in ["eliminate_prime", "eliminate_composite"]:
        elim.append(backtest.walk_forward_eliminate(
            strict_649, extra_rules.prime_score,
            f"prime({mode.split('_',1)[1]})",
            warmup=100, eliminate_n=15, mode=mode,
        ))

    # Day-of-week conditional cold
    dow_map = {0: "Mon", 3: "Thu"}
    for dow, name in dow_map.items():
        def _rule(past, target_dow=dow):
            # Apply only when prediction day matches target_dow — otherwise no signal expected.
            return extra_rules.day_of_week_score(past, target_dow=target_dow)
        elim.append(backtest.walk_forward_eliminate(
            strict_649, _rule, f"dow_cold({name})",
            warmup=100, eliminate_n=24,
        ))

    # Set-level filters
    filt: list[backtest.FilterResult] = []
    for (lo, hi) in [(0.05, 0.95), (0.10, 0.90), (0.20, 0.80)]:
        filt.append(backtest.walk_forward_filter(
            strict_649, set_filters.sum_range_filter,
            f"sum_range({int(lo*100)}-{int(hi*100)}%)",
            warmup=100, lo_pct=lo, hi_pct=hi,
        ))
    for me in [1, 2]:
        filt.append(backtest.walk_forward_filter(
            strict_649, set_filters.even_odd_filter,
            f"even_odd(min={me})", warmup=100, min_each=me,
        ))
    for mpd in [3, 4]:
        filt.append(backtest.walk_forward_filter(
            strict_649, set_filters.decade_spread_filter,
            f"decade_max{mpd}", warmup=100, max_per_decade=mpd,
        ))
    for mc in [2, 3]:
        filt.append(backtest.walk_forward_filter(
            strict_649, set_filters.consecutive_filter,
            f"consec(max{mc})", warmup=100, max_consecutive=mc,
        ))

    return elim, filt


def run_fourd_sweep(fd: pd.DataFrame) -> list[backtest.FilterResult]:
    """4D rules check whether each historical 1st prize would have passed."""
    out = []
    for elim_combo in [("quad",), ("quad", "triple"), ("quad", "triple", "double")]:
        name = "_".join(elim_combo)
        out.append(backtest.walk_forward_filter(
            fd, fourd_rules.quad_triple_filter,
            f"4d_no_{name}", warmup=500,
            candidate_col="first_prize", eliminate=elim_combo,
        ))
    for (lo, hi) in [(0.05, 0.95), (0.10, 0.90)]:
        out.append(backtest.walk_forward_filter(
            fd, fourd_rules.digit_sum_filter,
            f"4d_digit_sum_{int(lo*100)}-{int(hi*100)}%",
            warmup=500, candidate_col="first_prize", lo_pct=lo, hi_pct=hi,
        ))
    out.append(backtest.walk_forward_filter(
        fd, fourd_rules.first_digit_filter,
        "4d_first_digit_>=8%", warmup=500, candidate_col="first_prize",
    ))
    out.append(backtest.walk_forward_filter(
        fd, fourd_rules.last_digit_filter,
        "4d_last_digit_>=8%", warmup=500, candidate_col="first_prize",
    ))
    return out


def print_table(rows: list[dict], title: str, alpha: float | None = None) -> None:
    df = pd.DataFrame(rows)
    print(f"\n── {title} ──")
    if alpha is not None:
        print(f"(Bonferroni alpha = {alpha:.4f} after correcting for {len(rows)} tests)")
    print(df.to_string(index=False))


def main() -> None:
    # ─── TOTO ───
    toto = data.load_toto()
    strict_649 = backtest.filter_strict_649(toto)
    print(f"Strict 6/49 era: {len(strict_649)} draws")

    elim_results, filt_results = run_toto_sweep(strict_649)

    # Bonferroni-correct the elim p-values
    n_tests = len(elim_results)
    alpha_bonf = 0.05 / n_tests

    header(f"TOTO number-level elimination — {n_tests} rules (Bonferroni-corrected)")
    elim_rows = []
    for r in elim_results:
        row = r.as_row()
        row["bonf_sig?"] = "✓" if r.p_value < alpha_bonf else "·"
        elim_rows.append(row)
    print_table(elim_rows, "All rules (any individual ✓ at corrected alpha is real)", alpha_bonf)

    header(f"TOTO set-level filters — {len(filt_results)} rules")
    filt_rows = [r.as_row() for r in filt_results]
    print_table(filt_rows, "Pass-rate (close to 100% = safe to apply)")

    # ─── 4D ───
    fd = data.load_fourd()
    fd_results = run_fourd_sweep(fd)
    header(f"4D filters — {len(fd_results)} rules")
    fd_rows = [r.as_row() for r in fd_results]
    print_table(fd_rows, "Pass-rate (close to 100% = safe to apply)")

    # ─── Final verdict ───
    header("FINAL VERDICT")
    elim_sig = [r for r in elim_results if r.p_value < alpha_bonf]
    if not elim_sig:
        print(f"  TOTO number-level: NO rule passed Bonferroni-corrected significance (α = {alpha_bonf:.4f}).")
        print(f"  → The 6/49 lottery's number distribution is provably random within this archive.")
    else:
        print(f"  TOTO number-level: {len(elim_sig)} rule(s) passed corrected significance:")
        for r in elim_sig:
            print(f"     ✓ {r.rule_name:<30} lift {r.lift_pct:+5.2f}%  p={r.p_value:.2g}")

    print()
    safe_set_filters = [r for r in filt_results if r.pass_rate >= 0.95]
    print(f"  TOTO set-level filters with pass rate >= 95% ({len(safe_set_filters)} of {len(filt_results)}):")
    for r in sorted(safe_set_filters, key=lambda r: -r.pass_rate):
        print(f"     ✓ {r.rule_name:<30} pass {r.pass_rate*100:5.1f}%")

    print()
    safe_fd = [r for r in fd_results if r.pass_rate >= 0.90]
    print(f"  4D filters with pass rate >= 90% ({len(safe_fd)} of {len(fd_results)}):")
    for r in sorted(safe_fd, key=lambda r: -r.pass_rate):
        print(f"     ✓ {r.rule_name:<30} pass {r.pass_rate*100:5.1f}%  params={r.rule_kwargs}")


if __name__ == "__main__":
    main()
