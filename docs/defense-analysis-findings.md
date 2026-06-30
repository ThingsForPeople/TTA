# Defensive model — empirical findings (2026-06-29)

Analysis of whether the optimizer's defensive recommendations match *actual historical
outcomes*, using the production DB (all ~12 teams) joined to era-aligned sim stats.
**Findings only — no code changed yet.** This doc is the implementation reference for
the changes we discussed.

## Method

- **Source:** `replay_metrics` (6,288 fielding rows, positions 2–9, gauntlet excluded) joined
  to each player's sim stats *as they were at game time* — the `stat_history` snapshot
  at-or-before `completed_at`. **All 6,288 rows matched a real snapshot (zero fallback)**, so
  no current-vs-historical stat drift.
- **Unit:** one data point per (player, position), pooled across teams for stat variance.
- **PAE:** recomputed with a single **pooled** out-curve per position (`fitOutCurve`, minN 60)
  so it's comparable across teams.
- **Controls:** CON/POW/PIT/STA included as placebos. POW is near-orthogonal to FLD (r=0.22),
  so it estimates the "overall-quality halo" (~+0.3) baked into every raw correlation.
- **Validity anchors (join is sound):** within position, sim ARM → measured throw speed
  r≈0.91–0.96; sim SPD → range covered positive.

> Caveat throughout: only 10–14 regulars per position. The *direction* of the big findings is
> robust (stable across min-chance cuts); exact decimals — and all outfield/catcher numbers —
> are soft. More games will sharpen them.

## Finding 1 — Infield should be FLD-led, not ARM-led

FLD is the dominant, stable predictor of converting plays at every infield spot
(FLD→PAE: SS 0.94, 3B 0.92, 2B 0.87). The current weights crown ARM (SS/2B 0.40, 3B 0.52),
but once the quality-halo is removed ARM has ~0 marginal signal for *out conversion*. ARM is
near-deterministic for throw *speed* (r≈0.95) — that just doesn't translate into more outs.

### Proposed `DEFAULT_STAT_WEIGHTS` (fld / arm / spd)

| Pos | Current | Proposed | Note |
|---|---|---|---|
| SS | 0.27 / 0.40 / 0.33 | **0.52 / 0.20 / 0.28** | FLD-led; ARM kept as DP/throw prior |
| 2B | 0.32 / 0.40 / 0.28 | **0.50 / 0.20 / 0.30** | |
| 3B | 0.26 / 0.52 / 0.22 | **0.44 / 0.20 / 0.36** | FLD + SPD both strong; ARM weakest |
| 1B | 0.55 / 0.10 / 0.35 | **0.52 / 0.12 / 0.36** | ≈ unchanged (data's high 1B-ARM is halo) |
| C  | 0.42 / 0.48 / 0.10 | **0.45 / 0.35 / 0.20** | ARM moderated (Finding 2); low confidence |
| CF | 0.18 / 0.20 / 0.62 | **0.20 / 0.18 / 0.62** | ≈ unchanged; SPD-led correct |
| LF | 0.20 / 0.17 / 0.63 | **0.22 / 0.15 / 0.63** | ≈ unchanged |
| RF | 0.20 / 0.30 / 0.50 | **0.22 / 0.28 / 0.50** | RF arm = long-throw/deterrence prior |

The IF ARM floor (~0.20) is an explicit *prior* for double-play turns / throw margin /
deterrence — none of which PAE measures — and should be labeled as such in code comments,
not presented as data-derived.

## Finding 2 — Catcher arm barely affects caught-stealing

n=15 catchers, 405 steal attempts, league CS% = 41.7% (range 22–55%). CS% ↔ sim-ARM is weak
and sign-unstable (+0.14 / +0.40 / −0.03 at SA≥8/15/25), despite sim-ARM→throw-speed = 0.96.
A strong-armed catcher throws harder but doesn't catch meaningfully more runners — steal
outcomes look driven by runner speed / pitcher hold / randomness. Catcher defense is the
**least observable** position (blocking, framing, exchange never appear). Treat C weighting as
low-confidence.

## Finding 3 — True zone conversion (the leverage map)

From `oppSpray` (20,937 batted balls, *including hits that got through*), fraction turned into
outs by zone: **Infield 77–81%, shallow-OF 49–57%, deep-OF 40–48%, wall 5–8%.** The outfield
is the in-doubt band — strong support for the existing **OF > IF importance** ranking. It also
shows PAE's engaged-only view misses the un-reached balls that OF range converts.

## Finding 4 — 84% of OF "chances" are dead-ball retrievals (and the two-axis model)

The metrics pipeline counts every ground/fly `fielder.catch` as a "chance." But across 4 games,
**53 of 63 OF chances (84%) were ground balls fielded after they landed for a hit** (0% out
potential; all 10 genuine fly/line catches were converted). DB-wide corroboration: CF has
~2,334 engaged chances at >20 distance units converting ~3%.

**These retrievals are NOT valueless** (corrected from an earlier draft). They have zero *out*
potential, but they carry **extra-base-suppression** value:

- Of the 53: 34 singles, 18 doubles, **all involved a throw**, 0 assists.
- P(extra-base) by fielder travel-to-ball: `<12 → 0%`, `12–20 → 6%`, `20–26 → 45%`, `>26 → 100%`.
- Within hit-depth band carry 85–95: balls held to a single averaged travel 17.2; doubles 25.5.

So single-vs-double is driven by ball placement (batter) **and** fielder range/positioning/arm.

### The honest value model (three axes)

| Axis | Measures | Driven by | Today |
|---|---|---|---|
| **Outs (PAE)** | catchable balls → outs | FLD | yes, but polluted by retrievals |
| **Bases-saved** | holding hits to fewer bases / runner kills | SPD (range+positioning) + ARM (hold) | **no — invisible** |
| **Steal defense** (C) | caught stealing | weak | yes (weak) |

Bases-saved is the **missing half of outfield value** and explains why OF SPD/ARM barely move
PAE yet clearly matter. Proposed metric:

```
playValue = [ expectedBases(ball trajectory) − basesActuallyAllowed ] × leverage(base/out/score)
```

All inputs exist in the replay (see field inventory). Needs an expected-bases model to separate
fielder skill from batter placement — raw single/double counts won't do it.

## Recommended changes (priority order)

1. **Fix the OF dead-touch problem** — redefine "chance" using `flyBallOut`/`isGroundBall`
   (genuine air-out + IF grounder-with-out); exclude OF grounders that landed for hits from the
   out-curve/PAE/importance. Reclassify them into the bases-saved metric. *Requires re-sync.*
2. **Apply revised infield weights** (Finding 1).
3. **Build the bases-saved / expected-bases model** (Finding 4) — the missing OF value axis.
4. **Build a shared run-expectancy / leverage engine** from `gameState` (RE24 / WPA). Used by
   both defense (above) and offense (clutch weighting).

Always verify replay-derived stats against the box score (the existing standard).

## Rich replay fields currently UNUSED (relevant to defense and offense)

The metrics pipeline reads `catchType` + out-credit + a foul heuristic. The replay carries much
more, per `GET /api/replay/:gameId`:

- **`fielder.catch`**: `isGroundBall`, `flyBallOut` (clean air-out flag), `catchPoint`, `closePlay`,
  `interceptionPointIndex`. → cleaner than the current foul heuristic.
- **`ball.flight`**: `exitVelocity`, `launchAngle`, `horizontalAngle`, `distance`, `landingDistance`,
  `hitWall`, `clearedWall`, `wallDistance`, `wallHeight`, drag/air constants. → expected-bases,
  expected-outs, park effects.
- **`batter.contact`**: `exitVelocity`, `launchAngle`, `horizontalAngle`, `hitDepth`, `hitDirection`.
  → quality-of-contact / xwOBA model (offense).
- **`gameState`** (every segment): `score`, `hits`, `outs`, `balls`, `strikes`, `runners[3]`.
  → run expectancy, win probability, leverage.
- **`pitch.thrown` / `pitch.result` / `batter.action`**: `pitchType`, `mistake`, `inZone`, `outcome`,
  `madeContact`. → plate discipline, pitch-type effectiveness, swing decisions.
- **`talent.activated` / `effect.applied`**: in-game talent firings. → empirical talent valuation.
- **`fielder.move` / `cutoff_position` / `cover_base`**: positioning. → positioning analysis.
- **`runner.leadoff` / `steal` / `move` / `scored` / `safe`**: baserunning. → baserunning value.
