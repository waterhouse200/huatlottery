"""4D rules. The Singapore 4D pool is 0000-9999 (10,000 combinations).

Three categories of patterns are commonly cited as 'rare':
  - QUAD (1111) — all 4 digits same
  - TRIPLE (1112) — 3 of one digit
  - DOUBLE (1122) — exactly 2 pairs OR one pair
  - NONE  (1234) — all 4 distinct

Per the EDA, historical 1st prizes split:
  quad   :  0.1%
  triple :  3.8%
  double : 45.7%
  none   : 50.5%

So eliminating quad+triple removes 3.9% of historical 1st prizes
(big "AI ruled this out" narrative, low actual cost).
"""

from __future__ import annotations

from collections import Counter
import pandas as pd


def digit_class(s: str) -> str:
    counts = Counter(s)
    mx = max(counts.values())
    return {4: "quad", 3: "triple", 2: "double"}.get(mx, "none")


def quad_triple_filter(past: pd.DataFrame, prize_str: str,
                       eliminate: tuple[str, ...] = ("quad", "triple")) -> bool:
    """True if prize_str does NOT fall into the eliminated classes."""
    return digit_class(prize_str) not in eliminate


def digit_sum_filter(past: pd.DataFrame, prize_str: str,
                     lo_pct: float = 0.05, hi_pct: float = 0.95) -> bool:
    """True if sum-of-digits falls within historical [lo, hi] percentile."""
    past_sums = past["first_prize"].apply(lambda s: sum(int(c) for c in s))
    lo, hi = past_sums.quantile(lo_pct), past_sums.quantile(hi_pct)
    s = sum(int(c) for c in prize_str)
    return lo <= s <= hi


def first_digit_filter(past: pd.DataFrame, prize_str: str,
                       allowed_first: list[int] | None = None) -> bool:
    """True if the first digit is in the allowed set.
    If allowed_first is None, allow first digits that appear in >= 8% of past."""
    if allowed_first is None:
        first_counts = past["first_prize"].apply(lambda s: int(s[0])).value_counts(normalize=True)
        allowed_first = first_counts[first_counts >= 0.08].index.tolist()
    return int(prize_str[0]) in allowed_first


def last_digit_filter(past: pd.DataFrame, prize_str: str,
                      allowed_last: list[int] | None = None) -> bool:
    """True if the last digit is in the allowed set (>= 8% historical share)."""
    if allowed_last is None:
        last_counts = past["first_prize"].apply(lambda s: int(s[-1])).value_counts(normalize=True)
        allowed_last = last_counts[last_counts >= 0.08].index.tolist()
    return int(prize_str[-1]) in allowed_last
