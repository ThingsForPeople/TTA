# Data audit — unexploited stats in team-search & replays (2026-07-09)

> **STATUS: implemented same day** (branch `data-audit-buildout`) — items 1–7
> below plus both scrape fixes are now extracted/aggregated (re-sync required to
> populate). Corpus-verified (16 games): margins stored as runnerArrival −
> throwArrival ("beat"; outs are 100% throw-first — the raw payload's
> `runnerArrivalTime` is when the runner WOULD have arrived); `runner.safe`
> margins are only counted for `reason === 'steal'` (return_pitch/advance are
> not races); `overpowered` decoded (82% whiff on swings vs 49% — the Command
> lever) and surfaced per pitcher + per pitch type in evaluations/AI context;
> `zonesSeen` totals reconcile exactly with `pitchesSeen`; `activeSwings` ⊇
> `firedSwings` for all talent rows; rPAE/spray landing now prefers
> `ball.flight` geometry (median scale ratio 0.91 vs categorical depths).
> Item 8's fields remain intentionally unused.
>
> **Second wave (same day, branch `deep-analysis-buildout`)** — the analysis layer
> on top: platoon splits vs pitcher hand (AVG vL/vR in Advanced batting);
> rPAE/margins/exchange wired into `fieldingGrades`/Best Alignment/position
> comparison (rPAE-first everywhere); adjacency-aware lineup Monte Carlo
> (Rally Time / Clutch Cascade next-batter buffs from Talent Index magnitudes ×
> tier, triggers evaluated in-sim — verified the 2-opt moves chain holders and
> expected runs respond); bench offense impact (best swap per bench bat in
> runs/game, common-random-numbers); measured baserunning (run margins + steal
> jumps) into leadoff/slot-2 fit; **pitchZone decode** (row-major 1-9: 1-3 high,
> 7-9 low; cols 1/4/7 left, 3/6/9 right catcher-view; 10 = out of zone —
> verified via zone-talent activations for both hands, `scripts/decode-zones.ts`)
> → realized zone-talent Cover% in the talents view; buff-state contact added to
> the Talent Advisor AI context. Also corrected `MAX_TALENT_LEVEL` 5 → 4.

Field-by-field inventory of all four public data sources vs what the parsers
(`parseTeam.ts`, `parseReplay.ts`) actually consume. Post-patch payloads.

## Team-search page + roster-stats endpoint (identical 36-field player shape)

Fully consumed except:

- **`runs_allowed`** (pitching) — not mapped in `mapPlayer`. Minor (ERA is derived
  from it), but free to add to `Player.pitching`.
- **Pitching stats dropped for non-P players**: `mapPlayer` only builds `pitching`
  when `position === 'P' | 'SP'`. A Two Way (or anyone with `innings_pitched > 0`)
  listed at another position silently loses ERA/WHIP/IP/K. Fix: condition on
  `innings_pitched > 0 || isPitcher`.

## Games list + box score endpoints

Fully consumed (innings line score, team R/H/E, per-player batting+pitching
lines all render in `BoxScoreModal`). `runs_allowed` appears per line here too.

## Replay event log — unused fields, ranked by opportunity

1. **`segment.activeEffects`** (309/311 segments) — the full set of effects
   ACTIVE during each segment: `{targetEntityId, talentId, tier, polarity,
   source, tStart, tEnd}[]`. This is the state view we assumed didn't exist:
   per-pitch buff state for every player. Combined with the Talent Index
   magnitudes, enables true talent-value measurement (outcome WITH buff active
   vs without — not just "fired this segment"), stacking/state visibility, and
   opponent-inflicted debuff tracking (afflictions like Rattled on OUR batters).
   Top opportunity of the audit.
2. **Close-play margins** — `runner.out`/`runner.safe` carry `throwArrivalTime`
   + `runnerArrivalTime`; the delta is a continuous margin in seconds (negative
   = runner beat the throw). A far better arm/speed signal than the binary
   `closePlay` flag: infield arm margin, OF hold/advance margins, steal-defense
   margin. Cheap to accumulate per player.
3. **`pitch.thrown.velocity` / `overpowered` / `velocityMultiplier` /
   `movementMultiplier` / `pitchZone`** — per-pitch velocity (needed to value
   the new Extinguisher talent: contact per mph > 85), `overpowered` fires on
   ~50% of pitches (semantics worth decoding — likely the "Command/overpower"
   roll), and `pitchZone` gives the 3×3 zone per pitch → zone-talent coverage
   analysis against ACTUAL pitch distribution (how often does "Low" actually
   get pitched to this batter?).
4. **`fielder.throw.releaseBand`** (`slow/good/great`) + **`bobbled`** —
   categorical exchange quality; complements `releaseSum` and would let FLD
   stat-weights use a measured receive/exchange signal instead of a constant.
5. **`runner.steal.jumpQuality`** (`slow/…/great`) — steal-jump quality;
   baserunning talent (e.g. jump-related) validation + steal-success modeling.
6. **`ball.flight` physics** — `landingDistance`, `hitWall`/`clearedWall`,
   `wallDistance/Height`, `windSpeed/Direction`, `airDensity`. Uses: true
   landing coordinates for the rPAE spray charge (replace the categorical
   `SPRAY_DEPTH_RADIUS` approximation), wall-context for bases-saved, and
   per-ball weather conditioning of PAE/xwOBA (the weather confound noted in
   CLAUDE.md).
7. **`runner.leadoff.leadoffDistancePercent`** — leadoff size per pitch;
   baserunning-talent effects and steal-attempt modeling.
8. Low value / redundant: `batter.to_plate.statline` (cumulative in-game line —
   derivable), count-state duplicates (`pitch.windup/stretch/result` balls/
   strikes vs `gameState`), `ball.thrown` (mirrors `fielder.throw`),
   `fielder.move` routes, `effect.activated.tStart/tEnd` (durations),
   animation `duration`s, `metadata.pitchId`.

## Notes

- `gameState` (`balls/strikes/outs/runners/score/hits`) and player-object keys
  (`speed`, `coordinates`, `bats/throws`, `talents`) are already consumed.
- Sample: 1 fresh post-patch replay + endpoints re-fetched 2026-07-09; the
  event-type frequencies match the 31-game corpus scanned 2026-07-08.
