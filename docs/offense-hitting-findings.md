# Offense / hitting model — empirical findings (2026-06-29)

Mirror of the defensive analysis (`defense-analysis-findings.md`), applied to **batting**.
Which sim stats actually drive offensive outcomes, whether the batting-order engine's role
heuristics hold up, and how stable plate-discipline traits are. **Findings only — no app code
changed.** This doc is the implementation reference for the changes we discussed.

## Method

- **Source:** `replay_metrics` batting rows (gauntlet excluded, `pa > 0`) — **7,074 game rows**.
  Joined to each player's sim stats *as they were at game time*: the `stat_history` snapshot
  at-or-before `completed_at` (era-aligned), PA-weighted across the player's games. Only 224/7074
  rows predate a player's first snapshot (earliest-snapshot fallback) — negligible.
- **Unit:** one point per **(user, player)**, pooled across all ~12 teams for stat variance.
  Season-level rates from summed counting stats. **102 players ≥ 60 PA** (87 excluding pitchers),
  **34,029 PA total**, median 326 PA/player — a far healthier sample than the per-position
  defensive cuts, so these directions are solid.
- **Discipline:** OLS, both simple correlations and **standardized multiple regression** (z-scored
  betas) on all 7 sim stats, so the marginal contribution of each is separated from the
  intercorrelation. Sim stats are heavily collinear here (CON–SPD 0.62, SPD–FLD 0.79, CON–POW 0.59).
- **Placebo:** **PIT** (pitching) is included as a hitter placebo — it should have ~0 effect on a
  position player's bat, so it reads the "overall-quality halo." Re-ran excluding pitchers
  (`PIT ≥ 50`) to confirm.

> Rates here are replay-derived (no HBP/SF), so they differ slightly from the official box OBP,
> but the box-score reconciliation already established (AB/H/K/BB/2B/3B/HR exact) makes the
> direction and magnitude trustworthy.

## Headline: the sim is a HIGH-offense environment (fix the regression anchors)

League means across the pooled data:

| | This sim | Engine assumes | MLB ref |
|---|---|---|---|
| wOBA | **0.444** | 0.320 | ~.315 |
| OBP | **0.428** | 0.320 | ~.315 |
| AVG | **0.415** | — | ~.245 |

`analysis.ts` regresses small-sample hitters toward `LEAGUE_AVG_WOBA = 0.320` /
`LEAGUE_AVG_OBP = 0.320` (lines 67–68). Those constants are **~0.12 too low** for this sim. A
player with few PA is dragged toward a .320 mean that doesn't exist here, so low-PA hitters are
systematically **under-rated** and a hot small-sample bat is penalized harder than intended.
**This is the single highest-confidence, highest-impact fix.**

## Finding 1 — Which sim stats drive offense

Standardized betas (position players only, PIT placebo ≈ 0; full-set numbers in parentheses where they differ):

| Outcome | CON | POW | SPD | PIT (placebo) | Read |
|---|---|---|---|---|---|
| AVG | **0.48** | 0.02 | −0.18 | ~0.00 (−0.25) | CON only |
| OBP | **0.49** | 0.06 | −0.16 | ~0.00 (−0.24) | CON only |
| K% | **−0.76** | 0.48 | 0.57 | 0.15 | CON dominant |
| whiff% | **−0.50** | 0.49 | 0.62 | 0.14 | CON dominant |
| chase% | **−0.38** | −0.08 | −0.19 | 0.14 | CON |
| sweet-spot% | **0.24** | 0.10 | 0.21 | 0.12 | CON |
| SLG | 0.16 | **0.57** | 0.17 | −0.04 | POW |
| ISO | −0.14 | **0.84** | 0.40 | −0.06 | POW |
| HR% | −0.11 | **0.81** | −0.04 | 0.02 | POW |
| avg exit-velo | 0.15 | **0.50** | 0.09 | 0.05 | POW |

**CON is the contact / on-base / plate-discipline lever.** It owns AVG, OBP, and (negatively) K%,
whiff%, and chase%. Nothing else competes for the contact outcomes.

**POW is the power lever, and it is near-orthogonal to AVG/OBP** (β ≈ 0 there). It owns ISO, HR%,
SLG, exit velo, and fly-ball rate. CON and POW are cleanly separable axes — contact vs. thump.

**SPD has essentially NO independent value for box-rate offense.** After controls it is flat-to-
**negative** on AVG/OBP (−0.16 to −0.23). Its positive *simple* correlations (ISO 0.36, sweet-spot
0.40, BB% 0.34) are halo bleed from its 0.62 correlation with CON. This is the offensive twin of
the defense doc's "bases-saved is invisible" gap: SPD's real offensive value — **steals, infield
hits, first-to-third, taking the extra base** — does not live in PA-rate box stats and is simply
**not observable here**. Do not infer SPD has zero offensive value; infer that *these metrics
can't see it.*

**PIT placebo confirms the halo is small.** In the full set PIT read −0.25 on AVG/OBP, but that is
purely the **pitcher artifact** (pitchers carry high PIT and hit terribly, batting 9th). Excluding
pitchers collapses PIT to ~0.00 while CON/POW are unchanged — so the CON/POW signal is real, not a
generic quality halo. (Minor curiosity: ARM stays mildly negative on AVG/OBP even among hitters,
~−0.32 — low confidence, possibly strong-arm corner/OF types skewing power-over-contact.)

## Finding 2 — Batting-order role heuristics (the engine uses real box stats — mostly validated)

`buildBattingOrder` scores off **actual batting stats**, not sim projections, so it sidesteps the
sim-stat noise entirely. The role formulas check out, with two notes:

- **wOBA is the right master metric.** wOBA ↔ SLG 0.98, ↔ OBP 0.96, ↔ AVG 0.96, ↔ ISO 0.80. And
  `wOBA ~ OBP + SLG` reconstructs it at **R² = 1.00** — exactly as designed.
- **Leadoff (`obp*1.25 + 0.3*bbRate − 0.4*kRate`, slot 1):** correlates 0.98 with plain OBP, so it
  *is* OBP — the correct leadoff signal here. But the **`−0.4*kRate` term double-counts**: a K is
  already an out inside OBP, and K% carries **~0.00 marginal value beyond OBP+SLG** (regression
  above). It's a harmless tilt, but it is not a separate data-justified signal — recommend shrinking
  it (e.g. −0.15) or dropping it, and likewise the `+0.3*bbRate` term (BB%↔wOBA only 0.17, mostly
  redundant with OBP). OBP alone is the defensible leadoff score.
- **Cleanup (`woba + 0.4*isoP`, slot 4):** validated. ISO↔wOBA 0.80, POW→ISO 0.75 → ISO is genuine
  power. (`avgEV` is an equally good power proxy, ISO↔avgEV 0.69, but ISO/HR are fine and simpler.)
- **#5 (`woba − 0.4*kRate`) / #8 (`obp − 0.3*kRate`):** same double-count caveat as leadoff; minor.
- **SPD/steal value is unmodeled in slot scoring.** Given SPD has ~0 box-rate offensive value, the
  engine's choice to route speed through *baserunning talents* (not the SPD sim stat) is defensible
  — but stolen-base / extra-base run value remains unmeasured, the offensive mirror of the defense
  doc's missing "bases-saved" axis.

## Finding 3 — Plate-discipline profiles are real, stable per-player traits

Split-half reliability (odd vs. even games, players ≥ 12 games, Spearman-Brown corrected):

| Metric | mean | sd | split-half r | SB reliability |
|---|---|---|---|---|
| whiff% | 0.465 | 0.102 | 0.89 | **0.94** |
| sweet-spot% | 0.579 | 0.114 | 0.82 | **0.90** |
| chase% | 0.022 | 0.010 | 0.63 | **0.78** |

- **whiff% and sweet-spot% are highly reliable** — genuine, repeatable hitter skills, not noise.
  Both track CON (whiff −0.50, sweet-spot +0.55 simple). They'd make trustworthy per-player
  scouting tags well before a player has a stable AVG.
- **chase% is moderately reliable** and CON-driven (−0.55 simple). Note the absolute values are
  small because it's computed as `chases / pitchesSeen` (all pitches), not `chases / out-of-zone
  pitches` — it's directionally right but understated; a true chase rate needs the out-of-zone
  denominator (the replay has `inZone` per pitch — see field inventory).

## Proposed changes (propose only — priority order)

1. **Recalibrate the small-sample regression anchors in `src/lib/analysis.ts`** (highest impact):
   `LEAGUE_AVG_WOBA` and `LEAGUE_AVG_OBP` should reflect *this sim's* environment, ~**0.44 wOBA /
   ~0.43 OBP**, not 0.320. Better: derive them from the team/league actuals at runtime instead of a
   hardcoded MLB constant. As-is, every low-PA hitter is shrunk toward a phantom .320.
   *(The linear weights `W_1B…W_HR` are 2024 MLB; relative ordering is roughly preserved in a hotter
   environment, but if absolute wOBA is ever surfaced, it'll read low. Lower priority.)*

2. **Trim the K%/BB% tilt terms in `slotFit`** (leadoff, #5, #8): K% has ~0 marginal value beyond
   OBP, and it's already inside OBP. Shrink `−0.4*kRate` → ~`−0.15` (or drop) and reduce `+0.3*bbRate`.
   OBP is the correct, sufficient leadoff signal. Low risk, removes double-counting.

3. **Document the sim→offense mapping** wherever sim stats *project* hitting (not the order engine,
   which uses box stats — rather `RecruitAnalyzer`, `teamSummary.ts`/AI system prompt,
   `preComputedInsights.ts`): **CON = contact/OBP/K-avoidance**, **POW = power/SLG/ISO/HR/EV**,
   **SPD = baserunning value only (no batting-rate value — and largely invisible to our metrics)**.
   `RecruitAnalyzer`'s `RECRUIT_STAT_ORDER` (`pow, con, spd, …`) is reasonable, but SPD should be
   framed as defense/baserunning, not bat value.

4. **(Future) Build a baserunning / steal run-value model** from `runner.steal/stolen_base/scored`
   + `gameState` — the missing offensive axis where SPD actually pays off. Pairs naturally with the
   shared run-expectancy/leverage engine the defense doc proposes (item 4 there).

5. **(Future) Surface whiff% and sweet-spot% as scouting tags** — they stabilize fast (SB ≥ 0.90)
   and are CON-driven, so they're informative long before AVG settles. Fix chase% to use the
   out-of-zone denominator (`inZone` is in the replay) for a true chase rate.

Always verify replay-derived rates against the box score (the existing standard).
