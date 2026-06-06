"""Derived feature columns for TOTO + 4D analysis.

Two flavors of features:
  - **Per-draw**: aggregates over a single row (sum, even count, decade buckets…).
    Use add_toto_features() / add_fourd_features().

  - **Per-(draw, number)**: matrices where row=draw, col=number 1..49.
    gap_matrix_toto(df) — draws since each number last appeared (computed BEFORE the row's draw, so safe for prediction).
    rolling_frequency_toto(df, window) — count of each number in the last W draws (also strictly prior).

All feature builders are pure and deterministic.
"""

from __future__ import annotations

import pandas as pd
import numpy as np


# ─── Per-draw aggregates ─────────────────────────────────────────────
def add_toto_features(df: pd.DataFrame) -> pd.DataFrame:
    """Adds aggregate columns to the TOTO DataFrame.

    Adds: sum, even_count, odd_count, low_count (1-25), high_count (26-49),
    min_num, max_num, range_num, consecutive_pairs, decade_d1..d5,
    last_digit_unique.
    """
    out = df.copy()
    nums_col = out["numbers"]

    out["sum"]         = nums_col.apply(sum)
    out["even_count"]  = nums_col.apply(lambda ns: sum(1 for n in ns if n % 2 == 0))
    out["odd_count"]   = nums_col.apply(lambda ns: sum(1 for n in ns if n % 2 == 1))
    out["low_count"]   = nums_col.apply(lambda ns: sum(1 for n in ns if n <= 25))
    out["high_count"]  = nums_col.apply(lambda ns: sum(1 for n in ns if n > 25))
    out["min_num"]     = nums_col.apply(min)
    out["max_num"]     = nums_col.apply(max)
    out["range_num"]   = out["max_num"] - out["min_num"]
    out["consecutive_pairs"] = nums_col.apply(
        lambda ns: sum(1 for i in range(len(ns) - 1) if ns[i + 1] - ns[i] == 1)
    )

    for lo, hi, name in [(1, 10, "d1"), (11, 20, "d2"), (21, 30, "d3"),
                         (31, 40, "d4"), (41, 49, "d5")]:
        out[f"decade_{name}"] = nums_col.apply(
            lambda ns, lo=lo, hi=hi: sum(1 for n in ns if lo <= n <= hi)
        )

    out["last_digit_unique"] = nums_col.apply(lambda ns: len({n % 10 for n in ns}))

    return out


def add_fourd_features(df: pd.DataFrame) -> pd.DataFrame:
    """Adds digit-level features to 4D DataFrame.

    For each prize tier (1st, 2nd, 3rd), adds digit_sum and a *_class
    label: 'quad', 'triple', 'double', or 'none' (no repeated digit).
    """
    out = df.copy()
    for col in ["first_prize", "second_prize", "third_prize"]:
        out[f"{col}_digit_sum"] = out[col].apply(lambda s: sum(int(c) for c in s))
        out[f"{col}_class"]     = out[col].apply(_digit_class)
    return out


def _digit_class(s: str) -> str:
    """quad / triple / double / none, for a 4-digit string."""
    counts = {}
    for c in s:
        counts[c] = counts.get(c, 0) + 1
    mx = max(counts.values())
    return {4: "quad", 3: "triple", 2: "double"}.get(mx, "none")


# ─── Per-(draw, number) matrices ─────────────────────────────────────
def _toto_indicator(df: pd.DataFrame) -> pd.DataFrame:
    """1 if number n appeared in draw i, else 0. Shape (n_draws, 49)."""
    n_draws = len(df)
    mat = np.zeros((n_draws, 49), dtype="int64")
    for i, nums in enumerate(df["numbers"]):
        for num in nums:
            mat[i, num - 1] = 1
    return pd.DataFrame(mat, index=df.index, columns=range(1, 50))


def gap_matrix_toto(df: pd.DataFrame) -> pd.DataFrame:
    """For each draw, gap (number of draws) since each TOTO number last appeared.

    Value is computed using ONLY past draws — safe to use as input to a
    prediction for the current row. Sentinel value = n_draws for numbers
    that have never appeared before.

    Result shape: (n_draws, 49), columns 1..49.
    """
    n = len(df)
    last_seen: dict[int, int | None] = {k: None for k in range(1, 50)}
    SENTINEL = n
    rows = []
    nums_list = df["numbers"].tolist()

    for i in range(n):
        rows.append({
            k: (i - last_seen[k]) if last_seen[k] is not None else SENTINEL
            for k in range(1, 50)
        })
        for num in nums_list[i]:
            last_seen[num] = i

    return pd.DataFrame(rows, index=df.index, dtype="int64")


def rolling_frequency_toto(df: pd.DataFrame, window: int = 50) -> pd.DataFrame:
    """For each draw, count of each TOTO number in the previous `window` draws.

    Strictly past (shift(1)). Useful as input to hot/cold rules.

    Result shape: (n_draws, 49), columns 1..49.
    """
    indicator = _toto_indicator(df)
    rolled = indicator.shift(1).rolling(window=window, min_periods=1).sum()
    return rolled.fillna(0).astype("int64")


# ─── CLI smoke test ──────────────────────────────────────────────────
if __name__ == "__main__":
    from analysis import data
    toto = data.load_toto()
    toto_feat = add_toto_features(toto)
    print("TOTO features sample:")
    print(toto_feat[["draw_no", "sum", "even_count", "low_count", "range_num",
                     "decade_d1", "decade_d3", "decade_d5", "consecutive_pairs"]].tail(5))
    print()

    print("Gap matrix sample (last 3 draws, numbers 1..10):")
    gaps = gap_matrix_toto(toto)
    print(gaps.iloc[-3:, :10])
    print()

    print("Rolling frequency (window=50) sample (last 3 draws, numbers 1..10):")
    rf = rolling_frequency_toto(toto, window=50)
    print(rf.iloc[-3:, :10])
