# Replay-assessment audit (2026-07-10)

Complete audit of how the app assesses replays: what the re-sim data actually
represents, and whether position attribution through the pipeline is correct.
All claims below were verified empirically against live data (methods noted).

## 1. What a re-sim actually represents — VERIFIED GAME-TIME INPUTS

**Method:** for 8 games spread across a week (July 3 → July 10, two per epoch),
compared the replay against the game's box score — the box is frozen at game
time and is ground truth for who played, where, and in what order.

**Result: 8/8 exact matches** on all three axes:
- **Roster membership** — no players missing from or extra in any replay.
- **Fielding positions** — all nine per-player positions identical to the box.
- **Batting order** — replay first-PA order identical to box `batting_position`.

**Talent loadouts are game-time snapshots too:** the same players' talent
lists/levels DIFFER between a July-3 replay and a July-9 replay (new talents
appear, tiers rise, and one player shows a tier DECREASE + different talent —
consistent with a Lacuna reroll). So talent-trigger history per game is
faithful to what the player actually had in that game.

**Conclusion:** a re-sim replays the SAME matchup — game-time rosters,
positions, lineup, talents — with the outcome re-rolled under the current
engine. Consequences:
- Per-position splits ("where has this player played / how did he do there")
  are REAL history. The by-position breakdown, best-alignment matrix, and
  most-played primary are all built on genuine game-time positions.
- Only the OUTCOMES are hypothetical; distributions (PAE, whiff, EV) are
  samples of the current engine on historically accurate inputs — better than
  we previously claimed ("current roster matchup" in older docs was wrong).
- Cross-time comparisons mix engine versions only through the RNG, not inputs.

**Unverifiable:** whether the re-sim's weather matches the actual game's
weather (box scores carry no weather; 4/16 corpus games had rain). Sim stats
(CON/POW/…) aren't in the replay at all, so their game-time-ness is inferred
from the talent/position evidence, not proven.

## 2. Structural facts re-verified post-patch

- **Position numbering = standard scorekeeping.** Mean start coordinates over
  32 team-games: 1 = mound (0, −19), 2 = plate (0, +2.5), 3 = (+19, −26) 1B,
  4 = (+10, −43) 2B, 5 = (−19, −26) 3B, 6 = (−10, −43) SS, 7 = (−30, −59) LF,
  8 = (−1, −78) CF, 9 = (+30, −59) RF. `POS_NUM_TO_STR` is correct; +x is the
  RF side.
- **Innings are real baseball.** 17 half-innings when the home team leads
  after the top of the 9th (bottom skipped), 18 when full, 20 in extras
  (walk-offs observed). Nothing in the pipeline assumes 9 innings (verified);
  the `putouts ≈ 3×innings − K` identity uses actual innings.
- **`player.speed` is constant 5.0 for every player** in every audited replay —
  it is not an attribute. Nothing in the code consumes it (verified); the old
  "numeric velocity" doc note was corrected.
- **Weather varies per game** (deterministic within the cached re-sim);
  surfaced as a conditions note. Whether it reproduces the real game's weather
  is unknowable.
- **Catcher identification** (`ourCatcherId` = roster position 2) is sound —
  positions are fixed within a game (no substitutions).

## 3. Position-attribution code paths — one bug found & fixed

Audited: per-game position sourcing (replay roster → metrics rows → DB
`position` column), `byPosition` split gating, most-played primary, dynamic /
game-context / range curve pooling (all pool by the row's per-game position —
correct), nearest-fielder eligibility (3–9 by design), alignment matrix
(only positions actually fielded are eligible), steal credit.

**BUG (fixed): `empiricalFieldingBonus` anchored only at the PRIMARY
(most-played) position.** A player with 20 games at 2B and 12 at SS got ZERO
empirical anchor when the optimizer evaluated him at SS — real data ignored
exactly where it existed. Now `FieldingGrade.byPos` carries every played
split (games, rPAE-first anchor, bases-saved) and the bonus anchors at ANY
position with ≥ MIN_GAMES there; the transferable arm term is gated on
overall sample. Verified with synthetic splits: secondary-position anchor now
scores (was 0), unplayed positions get arm-only, low-sample splits gate out.

## 4. Framing corrections applied

The "re-sims might use current rosters" hedge was removed everywhere and
replaced with the verified game-time semantics: `system-prompt.ts` caveat,
`gameSummary` RESIM_NOTE, `ReplayAnalysis` banner, Advanced-fielding subtitle,
CLAUDE.md warning block, and memory. The practical upshot for the AI: replay
position/talent HISTORY is trustworthy; replay OUTCOMES are expected
performance, and box scores remain the only record of actual results.
