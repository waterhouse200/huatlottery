"""Hot/cold rule for TOTO number elimination.

Given the past draws, returns elimination scores for numbers 1..49.
Higher score = more eliminate-worthy.

Two modes (gambler's intuition is split on this — we test both):
  - **mode='cold'**: eliminate numbers that haven't appeared often recently
    (assumption: streaks continue; rare numbers will stay rare)
  - **mode='hot'**: eliminate numbers that have appeared often recently
    (assumption: gambler's "due" theory; cold numbers are coming back)
"""

from __future__ import annotations

import pandas as pd


def compute(past: pd.DataFrame, window: int = 50, mode: str = "cold") -> pd.Series:
    """Returns Series indexed 1..49 of elimination scores from past draws only.

    Args:
        past: DataFrame of TOTO draws strictly before the prediction draw.
        window: how many of the most recent past draws to count.
        mode: 'cold' (eliminate cold) or 'hot' (eliminate hot).
    """
    last_window = past.tail(window)
    counts = {n: 0 for n in range(1, 50)}
    for nums in last_window["numbers"]:
        for num in nums:
            counts[num] += 1
    freq = pd.Series(counts)

    if mode == "cold":
        return freq.max() - freq           # cold (low freq) → high score
    elif mode == "hot":
        return freq                         # hot (high freq) → high score
    else:
        raise ValueError(f"mode must be 'cold' or 'hot', got {mode!r}")
