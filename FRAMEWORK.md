# Huatlottery — App Framework & Navigation (SG + MY)

The structure everything plugs into, designed so adding operators/features never makes it messy.

## Core principles
1. **Organize by TASK, not by operator.** People come to *check results*, *explore stats*, *get numbers*, *check if they won* — not to hunt an operator's tab. Operator is a **filter inside a section**, never its own nav item.
2. **Operator = a selector, not a tab.** This is the one rule that keeps it clean: 5 operators today, 8 tomorrow → still the same small nav.
3. **Mobile-first.** ≤6 thumb-reachable nav items. No wall of tabs.
4. **Reuse the engine.** Stats/results functions take an `(operator, table)` parameter instead of being hardcoded per game.

## Navigation (sidebar) — 6 items
| Item | Contains |
|---|---|
| 🏠 **Home** | "Everything at once" — latest draw card per operator (SG+MY) + next-draw countdown + hot numbers. **Customizable** (show/hide/reorder cards, saved on device). |
| 📋 **Results** | Full draw results. Operator selector + date nav + full prize grid (1st/2nd/3rd/special/consolation). **"Did I Win?"** checker lives here, prominent. |
| 📊 **Statistics** | The deep analytics. Operator selector, then hot/cold · frequency · dry-streak · digit analysis · position bias. (Absorbs today's "TOTO Stats" + "4D Stats" + MY stats.) |
| 🎲 **Numbers** | Number tools: Lucky Numbers (BaZi/lunar) + Alpha 4D Simulator, as modes. |
| 🧠 **AI Prediction** | Kept standalone — strong search/SEO hook ("4D prediction"). Own URL for indexing. |
| ⋯ **More** | History Search · Payout tables · Disclaimer · language toggle. |

## The operator selector (the anti-mess device)
A pill bar at the top of **Results** and **Statistics**, region-grouped:
```
🇸🇬 SG 4D    🇸🇬 TOTO    ·    🇲🇾 Magnum    🇲🇾 Sports Toto    🇲🇾 Da Ma Cai
```
Selecting one filters the whole page. Remembered per session (localStorage `huat_op`).
Note: SG TOTO is a 6/49 lotto (different shape) — its stats page keeps its lotto-specific views; the 4D operators (SG 4D + 3 MY) share one 4D stats/results template.

### SG TOTO Winning Shares — CURRENT draw only (no history, no storage table)
Show the winning-shares table **only for the latest draw** so people see the winner counts; **do
NOT keep historical shares.** Groups 1–7, each = Share Amount + No. of Winning Shares (G1=match6
jackpot … G7=match3). If **Group 1 is "-" (no winner) → show "No winner — jackpot snowballs to the
next draw"** + the Group 1 Prize pool amount.
Minimal build: the scraper already fetches the latest SG Pools TOTO result page — just also parse its
Winning Shares table and stash the JSON on the *current* draw (a `shares_json` column on `toto_draws`,
populated going forward only; older rows stay null). UI renders it on the latest TOTO result card.
No `toto_prizes` table, no backfill. Terminology: "winning shares", not people.
Example — Draw 4196 (02 Jul): G1 "-"/snowball, G2 $127,051×2, G3 $1,560×112, G7 $10×107,052.

## Home widgets (customizable, no login)
Registry of widget render-fns; user picks which show + order, saved to `localStorage['huat_home']`
(same pattern as existing `huat_lang`). Default = all 5 operator "latest" cards + next-draw countdown.
Widgets: `sg4d` · `sgToto` · `magnum` · `sportstoto` · `damacai` · `countdown` · `hotNumbers` · `didIWin`.

## URL / routing (SEO-friendly, shareable)
- `?tab=results&op=magnum` · `?tab=stats&op=sportstoto` · `?tab=prediction` · `?tab=numbers`
- Each `(tab, op)` sets its own `<title>`/meta via the existing `updateSEO()` map (extended for MY + operators).

## How today's code maps in (what changes, what's reused)
- `getTabs()` → the 6 task-based items above (was 7 game-mixed items).
- `renderPage()` if/else → dispatch on `(tab, op)`; results/stats handlers take an operator param.
- `renderDashboard()` (hardcoded 2-card) → **widget registry** driven by `huat_home`.
- Stats/results SQL → parameterized by table (`fourd_draws` for SG 4D, `my_draws WHERE operator=?` for the rest). `my_draws` + `/api/my/*` already built.
- i18n (`L()`, en/zh JSON) → add `magnum/sportstoto/damacai` + `operators`/`results`/`stats`/`numbers` namespaces.
- Reused unchanged: cache layer, scraper engine, lucky/BaZi engine, disclaimer view.

## Build order (each ships standalone, no big-bang)
1. **Operator selector component** + wire SG4D/Magnum/Toto/DaMaCai into a shared **Results** view (proves the pattern on the deep data we just imported).
2. **Statistics** view parameterized by operator (hot/cold, frequency, dry-streak over 40 yrs of MY data).
3. **Home widget registry** + "everything at once" cards.
4. **Customize** panel (toggle/reorder, localStorage).
5. Nav re-label to the 6 task items; merge Lucky+Simulator into Numbers; SEO/i18n pass.
6. Payout table (reference), then PWA/notifications (retention) later.

## Out of scope / deliberately excluded
Betting/tickets/payments (never). Toto jackpot snowball games (Star/Power/Supreme) — excluded from the 4D payout/results per user. Operators beyond the big-3 MY + SG (Sabah/Sarawak/GD) — easy to add later via the same selector, not now.
