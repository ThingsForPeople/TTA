# Defense extras — DP conversion, extra-base suppression, positioning vs range (2026-06-29)

Follow-up to `defense-analysis-findings.md`, probing three replay-only signals that the
current metrics pipeline does **not** capture. **Findings only — no app source changed.**

## Data

9 recent replays for `019ddff2-…` (Confused Chuckles) — `/tmp/replay.json` + 8 in
`/tmp/rp2_*.json`. Our side detected per game by matching the team uuid to `game.home/away.id`.
Scratch scripts have been deleted; the raw JSON is left in `/tmp` for re-runs.

> Sample is **tiny** (9 games). Directions are believable and line up with the prior findings
> doc, but every decimal here is soft. Per-player splits are anecdote-grade. More games needed
> before any of this drives weights.

Internal consistency check (the verification standard, applied in-replay): the DP chain credited
exactly **3 DP finishes**, matching the **3** at-bats labeled `batter.result == 'double_play'`. PAE/
putout reconciliation against the box score is already established in the prior doc and unchanged.

---

## Task 1 — Double-play conversion (#5)

**Opportunity definition matters.** Counting *any* grounder in play with a runner on 1st & <2 out
gives 25 "opps", but **17 of those grounders were fielded by an outfielder** — i.e. balls that went
*through* the infield for a hit, which can never be a DP. Filtering to grounders **fielded by an
infielder (pos 3/4/5/6)** gives the honest denominator:

| Metric | Value |
|---|---|
| Infield-grounder DP opportunities (R1, <2 out) | **8** |
| DPs turned | **3** |
| Conversion rate | **38%** |
| IF-grounder DP opps by fielder | SS 4, 3B 2, 2B 2 |

Per-player DP roles (chain: starter = first to field / pivot = recorded an out then relayed onward /
finisher = recorded the final out):

| Player | Pos | Started | Pivot | Finished |
|---|---|---|---|---|
| Vincent Smith | SS | 2 | 0 | 0 |
| Ronald Hobbs | 2B | 0 | 3 | 0 |
| Arnold Ruth | 1B | 0 | 1 | 3 |
| Omar Chapman | 3B | 1 | 0 | 0 |

The team's DPs are the textbook **6-4-3** (SS feeds, 2B pivots, 1B finishes). Hobbs (2B) is the
pivot man on all 3. Sample is far too small to say a player turns DPs "well" vs "poorly" — there is
no player here with both a meaningful opportunity count *and* a contrasting peer at the same spot.

**Takeaway:** the existing `dpStarted/dpTurned/dpFinished` tags are correctly computed and the right
raw material. What's missing is a **denominator** — they're currently descriptive counts with no
"out of N chances." The DP-opportunity count above (IF grounder + R1 + <2 out) is computable from
`gameState.runners`/`outs` + the first IF `fielder.catch`, and would let a future DP-turn *rate* feed
the 2B/SS ARM/FLD prior (the prior doc already carries an explicit IF-ARM floor labeled "DP/throw
prior" — this would let it be data-anchored instead of hand-set).

---

## Task 2 — Arm deterrence / extra-base suppression (#6)

**Outfield assists are ≈0** (1 across 9 games) — confirms the prior doc: an assist-based arm signal
is useless. The value lives in **deterring/holding** the runner, which is observable via
`runner.move` (`reason:"advance"`, `fromBase`/`toBase`), `runner.scored`, and `runner.safe`
(`reason:"hold"`).

Aggregate, on hits **our outfielders fielded**:

| Situation | Took extra base | Rate |
|---|---|---|
| Runner on 1st → 3rd on a single | 6 / 23 | **26%** |
| Runner on 2nd scored on a single | 6 / 11 | **55%** |
| OF assist kills (runner thrown out) | 1 | — |

Per-outfielder (anecdote-grade):

| Player | Pos | Singles fielded | R1→3rd | R2 scored | Kills |
|---|---|---|---|---|---|
| Seth Arraez | CF | 30 | 2/11 (18%) | 3/5 | 1 |
| Allen Fulmer | CF | 13 | 2/6 (33%) | 1/2 | 0 |
| Gregory Hader | RF | 14 | 1/5 (20%) | 2/4 | 0 |

**The dominant driver is the fielder's travel-to-ball distance, not the runner.** P(runner takes the
extra base | OF travel distance to the ball):

| OF travel-to-ball | R1→3rd rate |
|---|---|
| < 14 units | **0%** (0/7) |
| 14–20 | 25% (3/12) |
| 20–26 | 100% (3/3) |
| > 26 | 100% (1/1) |

This reproduces Finding 4's `<12→0% / 12–20→6% / 20–26→45% / >26→100%` curve on a fresh, larger
sample. Hit **depth alone is noisy** (shortOutfield 29%, outfield 14%, wall 33%) — placement is a
batter property; the *fielder* signal is how far he had to range to it. So a bases-saved metric must
condition on ball location and credit the fielder for the **shortfall in travel** (range), which is
exactly the OF's invisible value.

**Proposed metric (feeds the planned bases-saved axis):** for each ball an OF fields with runners on,
```
basesSaved = Σ [ E(bases advanced | ball location, base/out state) − actual bases advanced ] × leverage
```
- *Ball location / expected advancement* from `ball.flight` (`landingDistance`, `horizontalAngle`,
  `hitDepth`) + `gameState.runners`/`outs` — the batter-placement baseline.
- *Fielder credit* = the residual; empirically tracks **OF travel-to-ball distance** (the table above),
  so range (closing on the ball from the fixed anchor) is the lever, with arm as a secondary deterrence
  prior (still partly unmeasurable — a strong arm that pre-emptively holds a runner records no event).
- *Leverage* from a shared RE24/WPA engine over `gameState` (the prior doc's item 4).
- Reclassify the OF "dead-touch" ground retrievals (Finding 4) out of PAE and **into this metric** —
  that's where their value actually is.

---

## Task 3 — Positioning vs range (#7)

**Conclusion: positioning is NOT a separable, player-controllable factor in this sim — so range as
currently measured already IS pure reaction range.** Three independent confirmations:

1. **No defensive shifts.** All **712** `fielder.move` events with a `targetPosition` for our side sit
   at distance **0.00** from the player's roster coordinate (0 moves > 2 units). `fielder.move`
   `targetPosition` is a *reset-to-home* event, not a pre-pitch shift. Only **4%** of catches were even
   preceded by such a move, and those moves don't relocate the fielder.
2. **Start coordinate is fixed per position, identical across players.** Every player who manned a
   position started at the exact same coordinate (sd = 0.0 on both axes across all games/players):
   SS (-10.2, -42.7), CF (-1, -78), 2B (9.3, -43.6), etc. A player's speed/skill does **not** move his
   starting point.
3. Therefore the current "range" = `dist(roster coord → catchPoint)` is travel **from a fixed anchor** —
   there is no positioning component baked into it to subtract out. Range and positioning are not
   confounded here because positioning is a constant.

Per-position mean travel-to-catch (units): SS 7.3, 2B 9.3, 3B 9.8, RF 14.6, LF 14.7, CF 16.7, 1B 18.1
(1B inflated by throw-receptions per the prior doc). OF travel >> IF travel, consistent with OF
carrying the leverage.

The only genuine *positioning* signal in the log is `fielder.cutoff_position` (relay/cutoff alignment
for throws — `targetBase`, `throwerId`), which is an **arm/relay** concept, not batted-ball range. It's
rare (5 events/game) and tied to the throw chain.

**Proposed refinement (not a positioning metric — that's impossible — but the right next step):**
because the anchor is fixed, scalar distance throws away *direction*. A ball 12 units to a fielder's
backhand/glove-side gap is harder than 12 units straight in. Make `expectedOut` **2D**: fit P(out) on
`(Δx, Δy)` from the fixed anchor (or distance × signed bearing) instead of scalar distance. The fixed
anchor makes this clean — every SS's geometry is identical, so a directional out-surface is well-defined
and would sharpen PAE (and the bases-saved residual) without any positioning data. `catchPoint{x,y}`
and the per-position anchor are already stored in `engageDists` (`x`/`y`), so this is a query-time re-fit,
no re-sync.

---

## Summary of proposed metric additions (all replay-derivable, none built)

1. **DP-turn rate** — denominator = IF-grounder + R1 + <2 out (from `gameState`); numerator = `double_play`
   results. Anchors the 2B/SS ARM/FLD "DP prior" with data instead of a hand-set floor. *(low priority —
   needs many more games; per-player DP samples are ~3.)*
2. **Bases-saved (the planned OF value axis)** — expected-minus-actual base advancement, conditioned on
   ball location (`ball.flight`) + base/out state, fielder credit driven by travel-to-ball, leverage-
   weighted. Absorbs the OF dead-touch retrievals out of PAE. **Highest value** — it's the missing half
   of OF value and the per-OF advancement-rate differences (Arraez 18% vs Fulmer 33% R1→3rd) hint it's
   real, just under-sampled. Requires the shared RE24/WPA engine.
3. **Directional (2D) out-curve** — replace scalar-distance `expectedOut` with `(Δx,Δy)`-from-fixed-anchor;
   sharpens PAE since fielders never reposition. Query-time re-fit, no re-sync (x/y already in `engageDists`).
4. **Do NOT build a positioning metric** — positioning is a fixed per-position constant in this engine;
   there is nothing to measure or credit. Range already isolates closing ability.
