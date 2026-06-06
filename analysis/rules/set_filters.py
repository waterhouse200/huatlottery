"""Set-level filters (vs number-level elimination).

These rules answer "would I have endorsed this candidate set?" rather
than "which individual numbers to eliminate?" Used for backtesting:
  - Compute pass rate against historical winners
  - If a filter PASSES 95%+ of historical winners, it's a safe filter
    (we eliminate sets that fail; we'd have lost only 5% of winners)
"""

from __future__ import annotations

import pandas as pd


def sum_range_filter(past: pd.DataFrame, numbers: list[int],
                     lo_pct: float = 0.10, hi_pct: float = 0.90) -> bool:
    """Pass if the set's sum is within the [lo_pct, hi_pct] quantile range
    of historical sums."""
    past_sums = past["numbers"].apply(sum)
    lo = past_sums.quantile(lo_pct)
    hi = past_sums.quantile(hi_pct)
    return lo <= sum(numbers) <= hi


def even_odd_filter(past: pd.DataFrame, numbers: list[int],
                    min_each: int = 1) -> bool:
    """Pass if at least `min_each` evens AND `min_each` odds."""
    e = sum(1 for n in numbers if n % 2 == 0)
    o = len(numbers) - e
    return e >= min_each and o >= min_each


def decade_spread_filter(past: pd.DataFrame, numbers: list[int],
                         max_per_decade: int = 3) -> bool:
    """Pass if no decade (1-10, 11-20, 21-30, 31-40, 41-49) has more
    than max_per_decade numbers."""
    decades = [0, 0, 0, 0, 0]
    for n in numbers:
        if 1 <= n <= 10:    decades[0] += 1
        elif n <= 20:        decades[1] += 1
        elif n <= 30:        decades[2] += 1
        elif n <= 40:        decades[3] += 1
        else:                decades[4] += 1
    return max(decades) <= max_per_decade


def consecutive_filter(past: pd.DataFrame, numbers: list[int],
                       max_consecutive: int = 2) -> bool:
    """Pass if no more than max_consecutive consecutive numbers (1-2-3-… style).
    e.g. max_consecutive=2 allows pairs like (5,6) but rejects (5,6,7)."""
    nums = sorted(numbers)
    run = 1
    max_run = 1
    for i in range(1, len(nums)):
        if nums[i] == nums[i - 1] + 1:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 1
    return max_run <= max_consecutive
