"""Generate weekly AI picks and write to the predictions table.

Generates 3 TOTO sets + 3 4D combinations that pass ALL of our validated
filters, then upserts them into a `predictions` table the Node API reads.

Run before each week:
    .venv/bin/python -m analysis.serve

Or with explicit week anchor:
    .venv/bin/python -m analysis.serve --for-week-of 2026-06-08
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from analysis import data, backtest
from analysis.rules import set_filters, fourd as fourd_rules

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH   = REPO_ROOT / "huatlottery.db"

N_PICKS_PER_GAME = 3
MAX_ATTEMPTS_PER_PICK = 5000


# ─── DB ──────────────────────────────────────────────────────────────
def init_predictions_table(conn: sqlite3.Connection) -> None:
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS predictions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      game         TEXT NOT NULL CHECK(game IN ('toto', '4d')),
      for_week_of  TEXT NOT NULL,   -- ISO Monday YYYY-MM-DD
      pick_idx     INTEGER NOT NULL,
      numbers      TEXT NOT NULL,   -- JSON array of ints for TOTO, JSON string for 4D
      rationale    TEXT,
      generated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(game, for_week_of, pick_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_lookup
      ON predictions(game, for_week_of, pick_idx);
    """)


# ─── Filter stacks (mirror analysis/combined.py) ─────────────────────
def all_toto_filters_pass(past, nums) -> bool:
    return (
        set_filters.consecutive_filter(past, nums, max_consecutive=3) and
        set_filters.decade_spread_filter(past, nums, max_per_decade=4) and
        set_filters.even_odd_filter(past, nums, min_each=1) and
        set_filters.sum_range_filter(past, nums, lo_pct=0.05, hi_pct=0.95)
    )


def all_fourd_filters_pass(past, prize_str) -> bool:
    return (
        fourd_rules.quad_triple_filter(past, prize_str, eliminate=("quad", "triple")) and
        fourd_rules.first_digit_filter(past, prize_str) and
        fourd_rules.last_digit_filter(past, prize_str) and
        fourd_rules.digit_sum_filter(past, prize_str, lo_pct=0.05, hi_pct=0.95)
    )


# ─── Pick generators ─────────────────────────────────────────────────
def generate_toto_picks(seed: int, past) -> list[dict]:
    rng = random.Random(seed)
    picks = []
    seen = set()
    attempts = 0
    while len(picks) < N_PICKS_PER_GAME and attempts < MAX_ATTEMPTS_PER_PICK * N_PICKS_PER_GAME:
        attempts += 1
        nums = tuple(sorted(rng.sample(range(1, 50), 6)))
        if nums in seen:
            continue
        if all_toto_filters_pass(past, list(nums)):
            seen.add(nums)
            picks.append({
                "numbers": list(nums),
                "rationale": "Passes all 4 statistical filters: balanced even/odd, "
                             "spread across decades, no long consecutive runs, "
                             "and sum within historical range.",
            })
    return picks


def generate_fourd_picks(seed: int, past) -> list[dict]:
    rng = random.Random(seed)
    picks = []
    seen = set()
    attempts = 0
    while len(picks) < N_PICKS_PER_GAME and attempts < MAX_ATTEMPTS_PER_PICK * N_PICKS_PER_GAME:
        attempts += 1
        s = f"{rng.randint(0, 9999):04d}"
        if s in seen:
            continue
        if all_fourd_filters_pass(past, s):
            seen.add(s)
            picks.append({
                "numbers": s,
                "rationale": "Passes filters: not all-same-digit (no quad), no triple, "
                             "first/last digits historically common, "
                             "digit sum within reasonable range.",
            })
    return picks


# ─── Upsert ──────────────────────────────────────────────────────────
def upsert_picks(conn: sqlite3.Connection, game: str, week_of: str,
                 picks: list[dict]) -> None:
    # Clear old picks for this (game, week) so re-running replaces cleanly
    conn.execute(
        "DELETE FROM predictions WHERE game = ? AND for_week_of = ?",
        (game, week_of),
    )
    for idx, p in enumerate(picks):
        nums_json = json.dumps(p["numbers"])
        conn.execute(
            "INSERT INTO predictions (game, for_week_of, pick_idx, numbers, rationale) "
            "VALUES (?, ?, ?, ?, ?)",
            (game, week_of, idx, nums_json, p["rationale"]),
        )


# ─── Main ────────────────────────────────────────────────────────────
def iso_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--for-week-of", help="ISO Monday date YYYY-MM-DD (defaults to current week's Monday)")
    args = parser.parse_args()

    if args.for_week_of:
        week_of = args.for_week_of
        try:
            datetime.strptime(week_of, "%Y-%m-%d")
        except ValueError:
            print(f"invalid date: {week_of}", file=sys.stderr)
            sys.exit(2)
    else:
        # This job runs Sunday night to prep the UPCOMING week's picks. But
        # iso_monday(Sunday) returns the Monday that is *ending* today (6 days
        # back), which labels picks for the week that just finished. Advance a
        # week on Sundays so the picks are for the upcoming Mon–Sun draws.
        today = date.today()
        monday = iso_monday(today)
        if today.weekday() == 6:  # Sunday
            monday += timedelta(days=7)
        week_of = monday.isoformat()

    # Stable seed derived from the FULL week_of (sha256) so re-running the same
    # week gives the same picks, but every week differs. (The old little-endian
    # &0xFFFFFFFF only kept the first 4 chars "2026", so every 2026 week was identical.)
    seed = int.from_bytes(hashlib.sha256(week_of.encode()).digest()[:4], "big")

    print(f"Generating AI picks for week of {week_of} (seed={seed})…")

    # Load data
    toto = data.load_toto(refresh=True)
    fourd = data.load_fourd(refresh=True)
    toto_649 = backtest.filter_strict_649(toto)

    toto_picks  = generate_toto_picks(seed, toto_649)
    fourd_picks = generate_fourd_picks(seed, fourd)

    if len(toto_picks) < N_PICKS_PER_GAME:
        print(f"  ⚠  Only generated {len(toto_picks)}/{N_PICKS_PER_GAME} TOTO picks "
              f"(filters may be too tight)")
    if len(fourd_picks) < N_PICKS_PER_GAME:
        print(f"  ⚠  Only generated {len(fourd_picks)}/{N_PICKS_PER_GAME} 4D picks")

    print("\nTOTO picks:")
    for i, p in enumerate(toto_picks):
        print(f"  {i+1}.  {'  '.join(f'{n:>2}' for n in p['numbers'])}")
    print("\n4D picks:")
    for i, p in enumerate(fourd_picks):
        print(f"  {i+1}.  {p['numbers']}")

    # Persist
    with sqlite3.connect(DB_PATH) as conn:
        init_predictions_table(conn)
        upsert_picks(conn, "toto", week_of, toto_picks)
        upsert_picks(conn, "4d",   week_of, fourd_picks)
        conn.commit()

    print(f"\n✅ Saved {len(toto_picks)+len(fourd_picks)} picks to predictions table for week {week_of}")


if __name__ == "__main__":
    main()
