"""Walk-forward backtest harness.

Two evaluation modes:
  1. **Number-level elimination**: rule returns elim scores for numbers 1..49.
     We eliminate top-N and count how many of the actual 6 winners survived.
  2. **Set-level filter**: rule answers "would I have endorsed this set?"
     We measure pass rate on actual historical winners.

Both modes use strict walk-forward — at draw N, we use ONLY draws < N.
Significance: one-sample t-test against the random-elimination baseline.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd
from scipy import stats


# ─── Filter helpers ──────────────────────────────────────────────────
# The current 6/49 format started on 9 Oct 2014 (draw #2995). Before that:
#   - 5/49 (1968 - ~1986)
#   - 6/42, 6/45, 6/49 (various, 1987-2014)
# Filtering by num6.notna() includes all 6-main-number formats (incorrectly
# treats 6/45 era as "6/49"). For rigorous testing, filter by date.
SIX_FORTY_NINE_START = pd.Timestamp("2014-10-09")


def filter_six_main(toto: pd.DataFrame) -> pd.DataFrame:
    """Keep any draw with 6 main numbers (includes 6/45 era — has data quirks)."""
    return toto[toto["num6"].notna()].copy().reset_index(drop=True)


def filter_strict_649(toto: pd.DataFrame) -> pd.DataFrame:
    """Keep only draws in the current 6/49 format (post-9-Oct-2014).

    This is the *correct* filter for hot/cold analysis: only here are all
    49 numbers physically available, so 'cold' actually means cold.
    """
    return toto[
        (toto["draw_date"] >= SIX_FORTY_NINE_START) & toto["num6"].notna()
    ].copy().reset_index(drop=True)


# Backward-compat alias
filter_649 = filter_six_main


# ─── Mode 1: number-level elimination ────────────────────────────────
@dataclass
class EliminationResult:
    rule_name: str
    eliminate_n: int
    n_evaluated: int
    baseline_survivors: float
    actual_survivors_mean: float
    actual_survivors_std: float
    lift: float
    lift_pct: float
    t_stat: float
    p_value: float
    significant: bool
    results_df: pd.DataFrame

    def as_row(self) -> dict:
        return {
            "rule": self.rule_name,
            "elim_n": self.eliminate_n,
            "n_draws": self.n_evaluated,
            "baseline_surv": round(self.baseline_survivors, 3),
            "actual_surv": round(self.actual_survivors_mean, 3),
            "lift_%": round(self.lift_pct, 2),
            "t": round(self.t_stat, 2),
            "p": f"{self.p_value:.2g}",
            "p<0.05?": "✓" if self.significant else "·",
        }


def walk_forward_eliminate(
    toto: pd.DataFrame,
    rule_fn: Callable[..., pd.Series],
    rule_name: str,
    warmup: int = 200,
    eliminate_n: int = 24,
    **rule_kwargs,
) -> EliminationResult:
    """Run the rule walk-forward, eliminate top-N per draw, score survivors."""
    rows = []
    for i in range(warmup, len(toto)):
        past = toto.iloc[:i]
        scores = rule_fn(past, **rule_kwargs)
        elim_set = set(scores.sort_values(ascending=False).head(eliminate_n).index)
        actual = set(toto["numbers"].iloc[i])
        rows.append({
            "draw_no": int(toto["draw_no"].iloc[i]),
            "draw_date": toto["draw_date"].iloc[i],
            "n_winners": len(actual),
            "survivors": len(actual - elim_set),
        })
    df = pd.DataFrame(rows)
    df["survival_rate"] = df["survivors"] / df["n_winners"]

    keep_n = 49 - eliminate_n
    baseline_per_row = df["n_winners"] * keep_n / 49
    baseline = float(baseline_per_row.mean())
    actual_mean = float(df["survivors"].mean())
    t, p = stats.ttest_1samp(df["survivors"], baseline)

    return EliminationResult(
        rule_name=rule_name,
        eliminate_n=eliminate_n,
        n_evaluated=len(df),
        baseline_survivors=baseline,
        actual_survivors_mean=actual_mean,
        actual_survivors_std=float(df["survivors"].std()),
        lift=actual_mean - baseline,
        lift_pct=(actual_mean - baseline) / baseline * 100,
        t_stat=float(t),
        p_value=float(p),
        significant=p < 0.05,
        results_df=df,
    )


# ─── Mode 2: set-level filter ────────────────────────────────────────
@dataclass
class FilterResult:
    rule_name: str
    n_evaluated: int
    pass_rate: float
    naive_random_pass_rate: float    # what % of random sets would pass
    rule_kwargs: dict

    def as_row(self) -> dict:
        return {
            "rule": self.rule_name,
            "n_draws": self.n_evaluated,
            "pass_rate": f"{self.pass_rate * 100:.1f}%",
            "vs_random": f"{(self.pass_rate - self.naive_random_pass_rate) * 100:+.1f}pp",
            "params": str(self.rule_kwargs),
        }


def walk_forward_filter(
    df: pd.DataFrame,
    filter_fn: Callable[..., bool],
    rule_name: str,
    warmup: int = 200,
    naive_random_pass_rate: float = 0.0,
    candidate_col: str = "numbers",
    **filter_kwargs,
) -> FilterResult:
    """Run a set filter against historical winners. Measures pass rate.

    For TOTO, candidate_col='numbers' (the 6-number list).
    For 4D,  candidate_col='first_prize' (the 4-digit string).
    """
    rows = []
    for i in range(warmup, len(df)):
        past = df.iloc[:i]
        candidate = df[candidate_col].iloc[i]
        passed = filter_fn(past, candidate, **filter_kwargs)
        rows.append({
            "draw_no": int(df["draw_no"].iloc[i]),
            "draw_date": df["draw_date"].iloc[i],
            "passed": bool(passed),
        })
    rdf = pd.DataFrame(rows)
    return FilterResult(
        rule_name=rule_name,
        n_evaluated=len(rdf),
        pass_rate=float(rdf["passed"].mean()),
        naive_random_pass_rate=naive_random_pass_rate,
        rule_kwargs=filter_kwargs,
    )


# ─── Pretty-print tables ─────────────────────────────────────────────
def print_elim_table(results: list[EliminationResult]) -> None:
    rows = [r.as_row() for r in results]
    df = pd.DataFrame(rows)
    print(df.to_string(index=False))


def print_filter_table(results: list[FilterResult]) -> None:
    rows = [r.as_row() for r in results]
    df = pd.DataFrame(rows)
    print(df.to_string(index=False))
