"""Extra rules to sweep for any number-level signal we may have missed.

Each function: (past_draws) → Series indexed 1..49 of elim scores
(higher = eliminate). Used by walk_forward_eliminate.
"""

from __future__ import annotations

import pandas as pd


# 1. Day-of-week-specific frequency
def day_of_week_score(past: pd.DataFrame, target_dow: int) -> pd.Series:
    """How often did each number appear on a draw with this day-of-week?
    Returns score where high = COLD on that day (eliminate cold on this dow)."""
    dated = past[past["dow"].notna() & (past["dow"] == target_dow)]
    counts = {n: 0 for n in range(1, 50)}
    for nums in dated["numbers"]:
        for n in nums:
            counts[n] += 1
    freq = pd.Series(counts)
    return freq.max() - freq           # cold gets high score


# 2. Repeat-from-previous
def repeat_from_previous_score(past: pd.DataFrame, mode: str = "eliminate_repeat") -> pd.Series:
    """Numbers that appeared in the LAST draw.

    mode='eliminate_repeat'  → eliminate numbers from the last draw (no-repeat theory)
    mode='eliminate_non_repeat' → eliminate numbers NOT in the last draw (continues-theory)
    """
    if len(past) == 0:
        return pd.Series({n: 0 for n in range(1, 50)})
    last_nums = set(past["numbers"].iloc[-1])
    if mode == "eliminate_repeat":
        return pd.Series({n: (1 if n in last_nums else 0) for n in range(1, 50)})
    elif mode == "eliminate_non_repeat":
        return pd.Series({n: (0 if n in last_nums else 1) for n in range(1, 50)})
    else:
        raise ValueError(f"unknown mode: {mode!r}")


# 3. Additional-number-correlation: does the additional num predict main nums?
def additional_correlation_score(past: pd.DataFrame, last_additional: int | None = None) -> pd.Series:
    """For the past draws, count how often each number co-appeared with the
    most-recent additional number. Returns score where high = NEVER co-appeared
    (eliminate these)."""
    if len(past) == 0:
        return pd.Series({n: 0 for n in range(1, 50)})
    if last_additional is None:
        last_additional = int(past["additional_num"].iloc[-1])
    coappear = {n: 0 for n in range(1, 50)}
    matched = past[past["additional_num"] == last_additional]
    for nums in matched["numbers"]:
        for n in nums:
            coappear[n] += 1
    s = pd.Series(coappear)
    return s.max() - s if s.max() > 0 else s


# 4. Last-digit clustering
def last_digit_score(past: pd.DataFrame, window: int = 100) -> pd.Series:
    """Frequency of each number's last digit (n%10) in the rolling window.
    Eliminate numbers whose last digit has been overrepresented recently."""
    last_window = past.tail(window)
    digit_counts = {d: 0 for d in range(10)}
    for nums in last_window["numbers"]:
        for n in nums:
            digit_counts[n % 10] += 1
    # Score numbers by how hot their last digit is → eliminate hot-digit numbers
    return pd.Series({n: digit_counts[n % 10] for n in range(1, 50)})


# 5. Prime vs composite
def prime_score(past: pd.DataFrame, mode: str = "eliminate_prime") -> pd.Series:
    """Constant score per number based on primality."""
    primes_under_50 = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47}
    if mode == "eliminate_prime":
        return pd.Series({n: (1 if n in primes_under_50 else 0) for n in range(1, 50)})
    elif mode == "eliminate_composite":
        return pd.Series({n: (0 if n in primes_under_50 else 1) for n in range(1, 50)})
    else:
        raise ValueError(f"unknown mode: {mode!r}")
