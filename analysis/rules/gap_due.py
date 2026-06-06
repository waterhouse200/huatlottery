"""Gap-based rules: how many draws since each number last appeared.

Two intuitions to test:
  - **mode='due'**: numbers with the longest gap are "due" to appear
    (gambler's fallacy — statistically wrong but emotionally popular).
    These would *survive* (not get eliminated). Score = -gap.
  - **mode='recent'**: numbers that just appeared are "spent" and won't
    repeat soon. Eliminate the recently-seen. Score = -gap inverted.

We use the elimination framework: higher score = eliminate.
"""

from __future__ import annotations

import pandas as pd


def compute(past: pd.DataFrame, mode: str = "due") -> pd.Series:
    """Returns Series indexed 1..49 of elimination scores."""
    last_seen = {n: -1 for n in range(1, 50)}
    nums_list = past["numbers"].tolist()
    for i, nums in enumerate(nums_list):
        for n in nums:
            last_seen[n] = i

    n_draws = len(past)
    gaps = pd.Series({
        n: (n_draws - last_seen[n]) if last_seen[n] >= 0 else n_draws
        for n in range(1, 50)
    })

    if mode == "due":
        # Eliminate numbers with SHORT gap (recently seen, not "due")
        return gaps.max() - gaps
    elif mode == "recent":
        # Eliminate numbers with LONG gap (haven't appeared, considered cold)
        return gaps
    else:
        raise ValueError(f"mode must be 'due' or 'recent', got {mode!r}")
