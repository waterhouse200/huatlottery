"""SQLite → pandas DataFrames for analysis.

The Node scraper populates huatlottery.db. This module is the read-only
Python access layer used by features.py, rules/*, backtest.py, and notebooks.

Cache layer: each loader can persist to a feather/parquet file so notebooks
restart fast. To rebuild from DB: `load_toto(refresh=True)`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import sqlite3

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH    = REPO_ROOT / "huatlottery.db"
CACHE_DIR  = REPO_ROOT / "analysis" / "_cache"
CACHE_DIR.mkdir(exist_ok=True)


def _conn() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


# ─── TOTO ────────────────────────────────────────────────────────────
def load_toto(refresh: bool = False) -> pd.DataFrame:
    """Returns one row per TOTO draw.

    Columns:
      draw_no (int), draw_date (datetime64[ns], may be NaT for pre-1997),
      num1..num6 (Int64, nullable — num6 is null for 5/49-era draws),
      additional_num (int),
      numbers (List[int], 5 or 6 main numbers, ascending — for convenience),
      year, month, dow (int, day of week 0=Mon..6=Sun, NaN for undated)
    """
    cache = CACHE_DIR / "toto.feather"
    if cache.exists() and not refresh:
        return pd.read_feather(cache)

    with _conn() as conn:
        df = pd.read_sql_query(
            "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num "
            "FROM toto_draws ORDER BY draw_no ASC",
            conn,
        )

    df["draw_date"] = pd.to_datetime(df["draw_date"], errors="coerce")

    # Cast nullable ints (num6 is null for 5/49-era)
    for c in ["num1", "num2", "num3", "num4", "num5", "num6", "additional_num"]:
        df[c] = df[c].astype("Int64")

    # Convenience: main numbers as a Python list per row (drops NaN)
    main_cols = ["num1", "num2", "num3", "num4", "num5", "num6"]
    df["numbers"] = df[main_cols].apply(
        lambda row: sorted(int(n) for n in row if pd.notna(n)), axis=1
    )

    # Date features (NaN-safe)
    df["year"]  = df["draw_date"].dt.year.astype("Int64")
    df["month"] = df["draw_date"].dt.month.astype("Int64")
    df["dow"]   = df["draw_date"].dt.dayofweek.astype("Int64")

    df.reset_index(drop=True).to_feather(cache)
    return df


# ─── 4D ──────────────────────────────────────────────────────────────
def load_fourd(refresh: bool = False) -> pd.DataFrame:
    """Returns one row per 4D draw.

    Columns:
      draw_no (int), draw_date (datetime64[ns]),
      first_prize, second_prize, third_prize (str, 4 digits, zero-padded),
      starter_prizes  (List[str], 8 or 10 entries),
      consolation_prizes (List[str], usually 10 entries),
      year, month, dow
    """
    cache = CACHE_DIR / "fourd.feather"
    if cache.exists() and not refresh:
        return pd.read_feather(cache)

    with _conn() as conn:
        df = pd.read_sql_query(
            "SELECT draw_no, draw_date, first_prize, second_prize, third_prize, "
            "starter_prizes, consolation_prizes "
            "FROM fourd_draws ORDER BY draw_no ASC",
            conn,
        )

    df["draw_date"] = pd.to_datetime(df["draw_date"], errors="coerce")
    df["starter_prizes"]      = df["starter_prizes"].apply(json.loads)
    df["consolation_prizes"]  = df["consolation_prizes"].apply(json.loads)
    df["year"]  = df["draw_date"].dt.year.astype("Int64")
    df["month"] = df["draw_date"].dt.month.astype("Int64")
    df["dow"]   = df["draw_date"].dt.dayofweek.astype("Int64")

    df.reset_index(drop=True).to_feather(cache)
    return df


# ─── Quick sanity helper for notebooks ───────────────────────────────
def summary() -> str:
    t = load_toto()
    f = load_fourd()
    lines = [
        f"TOTO : {len(t):>5} rows    (#{int(t.draw_no.min())} → #{int(t.draw_no.max())})",
        f"       dated: {int(t.draw_date.notna().sum()):>5}, undated: {int(t.draw_date.isna().sum()):>5}",
        f"       5-main (5/49 era): {int(t.num6.isna().sum()):>4}, 6-main: {int(t.num6.notna().sum()):>4}",
        f"4D   : {len(f):>5} rows    (#{int(f.draw_no.min())} → #{int(f.draw_no.max())})",
        f"       {f.draw_date.min().date()} → {f.draw_date.max().date()}",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    print(summary())
