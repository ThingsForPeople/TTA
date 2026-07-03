# Empirical talent valuation & pitch-type effectiveness (2026-06-29)

Analysis of 10 recent replays for **Confused Chuckles** (`019ddff2-6cbc-7ecb-b0b1-a6b511f3379e`),
both teams pooled (a talent is a talent regardless of side), **818 at-bats / ~2,269 pitches**.
Addresses TODO #8 (empirical talent valuation) and #9 (pitch-type effectiveness).
**Findings only — no app source changed.** Box score reconciled exactly for one game
(replay vs `/games/:id`: AB 51, H 25, K 12, 2B 7, HR 5 — identical), so the parse is sound.

Games used (all on `/tmp/rp_*.json`): 17dfa25a, 7a93d980, ee45d1ac, 7d76153e, 33fdeb89,
019f15f8, 9885d22c, 99878d03, 019f15e6, 5a9b9922.

> Units: "EV" is the sim's exit-velocity scale (~27–45 range here), **not mph**. Treat all
> exact decimals as soft at this sample; the *directions* of the headline findings are stable.

---

## TODO #8 — Talent valuation

### Method & the central caveat

`talent.activated{ownerId, talentId, trigger}` fires inside a segment carrying `atBatId`.
The obvious test — *outcome when a talent fired vs the same owner's at-bats when it didn't* —
is **badly confounded by situation selection**, because activation is endogenous to the count /
pitch location:

- **Count-escalation talents** (`Battler`/count_fighter, `Knowledge is Power`/at_bat_escalation,
  `Pressure Cooker`/release_valve) fire *deep in counts* → those at-bats end in more K and weaker
  contact regardless of the talent. They show large **negative** raw deltas (Battler ΔwOBA −0.44,
  ΔK +0.64; Knowledge is Power ΔwOBA −0.43) that are **artifacts of when they fire, not talent
  quality**. These are **not cleanly valuable** from activation timing.
- **Zone-swing talents** "activate" only when the batter swings at a pitch in their zone, so the
  active bucket is swing-heavy (fewer walks, more K) — again a selection artifact in the raw
  outcome contrast.
- **Always-on talents** (`Set the Tone`/first_pitch_hunter, `Sweet Tooth`) activate in ~100% of
  the owner's at-bats → **no contrast possible**, unmeasurable by this method.

**The clean test** is *conditional on contact* (batted balls with an EV only): it removes the
K/walk selection and directly checks the `talentEffects.ts` mechanism — does the talent shift
**exit velo** and **batted-ball type** the way the lever map claims? This is where the real signal is.

### Result 1 (robust): the **Driver** family genuinely adds line drives + EV

Conditional on contact, owner-pooled (Δ = active − inactive batted balls):

| Talent (lever: `line_drive_chance`) | nBB | Δ line-drive share | Δ EV |
|---|---|---|---|
| Low Driver | 65 | **+0.39** | **+2.8** |
| High Driver | 52 | **+0.36** | **+3.2** |
| Outside Driver | 79 | **+0.35** | +1.0 |
| Inside Driver | 73 | **+0.28** | +1.9 |

All four directions independently push +28–39 pts of line-drive share and +1 to +3.2 EV.
The **Dialed** (contact_chance) talents engaged in the *same zones* show near-zero EV shift
(Inside −0.0, High −1.6, Outside −0.9) and smaller LD shifts — so this isn't just "pitch-in-my-zone"
selection; the **Driver effect is differentially real**. Strong support for `talentEffects.ts`
ranking **Driver = highest-value batted-ball talent**.

### Result 2 (robust, standout): **Mental Warfare** (`ice_water`, `pitch_mistake_chance`)

97 active batted balls: **+7.8 EV** and **+0.35 line-drive share** vs inactive. By far the biggest
contact-quality swing of any talent. Mechanism is coherent: it raises the pitcher's mistake chance,
and when it fires the batter is punishing a hittable mistake. (Endogeneity caveat: activation may
partly *mark* the mistake rather than cause it — but the payoff when it triggers is unambiguously
large.) **This talent looks materially undervalued** — it isn't represented in any optimizer bonus today.

### Result 3 (robust): **Hacker** (swing_chance) lowers contact quality — it's the double-edged one

`Outside Hacker` ΔEV −2.6 / Δground +0.31 / Δline −0.41; `Inside Hacker` ΔEV −1.3. More swings →
more chases → weaker, more-grounded contact. Confirms `ZONE_HIT_EFFECT` ranking **Hacker last (rank 1)**,
and suggests it should arguably be a **slight penalty** for low-SPD hitters (grounders only pay off
with speed).

### Result 4 (weak / not supported): **Popper** (fly_ball_chance) shows no clear payoff

Poppers barely move fly-ball share and **do not add EV** (Outside Popper ΔEV −2.6; High +0.3;
Inside +0.7; Low +1.5 — mixed, small). The data does **not** support `Popper > Chopper`
(current ranks 3 > 2). Popper looks like a pure trajectory nudge with no contact-quality benefit.

### Result 5: **Dialed** is contact-neutral on EV (as designed), small LD bump

Inside/Low Dialed +0.12–0.13 line-drive share, EV ~flat. Consistent with `contact_chance`
(makes contact, doesn't add authority). Rank 4 is fine.

### Power talents — directionally positive, small samples

`Righty Tighty` +2.4 EV (n=47), `The Janitor`/cleanup_catalyst +2.9 EV (n=9), `Clutch`/pressure_cooker
+0.5 EV (n=173, near-neutral). All point the right way (power → EV) but only Righty Tighty has
enough sample to trust. **Clutch is close to neutral on contact quality here** — its value, if any,
is leverage-timing (runners on), which this contact-only test can't isolate.

### Fielding talents — **unmeasurable** from replays (confirmed)

`Charger`, `Heads & Tails`, `Hot Potato`, `Warmed Up`, `No Doubles`, `Pop Time` either fire on
~95% of the owner's fielding chances (always-on: Hot Potato 141/153 catches, 121/127 throws) or
their activation is **positionally confounded** (Charger/Heads & Tails "activate" on short-distance
IF plays — 9.3 vs 12.3 avg distance — because that's the play *type*, not a range gain). Throw-speed
contrasts are noise (Hot Potato 31.3 active vs 34.0 inactive, n=6 inactive). **The hand-tuned
`FIELDING_TALENT_RULES` in `rosterOptimizer.ts` cannot be empirically refined from this data** —
keep them as priors. (Bigger picture: the bases-saved metric in `defense-analysis-findings.md`
is the only path to measuring OF range/arm talents.)

### Talent valuation — summary table

| Talent | Lever | Measurable? | Empirical read |
|---|---|---|---|
| Driver (all 4 zones) | line_drive_chance | **Yes** | +0.28–0.39 LD share, +1 to +3.2 EV. **Highest-value hitting talent.** |
| Mental Warfare | pitch_mistake_chance | **Yes** | +7.8 EV when fired. **Standout; likely undervalued.** |
| Hacker (zones) | swing_chance | **Yes** | −1 to −2.6 EV, more grounders. Double-edged; lowest rank correct. |
| Righty Tighty | contact+power | Yes (n=47) | +2.4 EV. |
| Dialed (zones) | contact_chance | Partial | EV-neutral, small +LD. Contact talent, rank 4 OK. |
| Popper (zones) | fly_ball_chance | Partial | No EV gain, weak fly shift. **Not > Chopper.** |
| The Janitor / Clutch | power | Weak (small/neutral) | Janitor +2.9 EV (n=9); Clutch ~neutral on contact. |
| Battler, Knowledge is Power, Pressure Cooker | foul/power/escalation | **No** | Activation = deep counts → negative artifact. Situation, not talent. |
| Set the Tone, Sweet Tooth, Disciplined | contact/HR/swing | **No** | Always-on (~100% of ABs) → no contrast. |
| Charger, Heads & Tails, Hot Potato, Warmed Up, No Doubles, Pop Time | fielding | **No** | Always-on / positionally confounded. Keep hand-tuned priors. |

### Proposed concrete changes (TODO #8)

1. **`ZONE_HIT_EFFECT` in `talentEffects.ts`** — data supports a sharper spread than the current
   Driver 5 / Dialed 4 / Popper 3 / Chopper 2 / Hacker 1:
   - **Driver → keep 5** (confirmed strongest: +LD and +EV).
   - **Dialed → keep 4** (confirmed contact, EV-neutral).
   - **Popper → drop from 3 toward 2** (no EV benefit; not above Chopper in the data).
   - **Chopper → 2** (unchanged; grounder bias, situational).
   - **Hacker → keep 1**, and consider making it a **net-negative** modifier unless the batter has
     high SPD (the grounders/chases it adds only pay off for speedsters).
2. **Add an offensive-talent bonus for `Mental Warfare`** to the batting-order engine (it currently
   has none). On this evidence it's one of the most valuable bats-side talents — treat it like a
   power/clutch talent (boost run-producing lineup slots).
3. **Leave `FIELDING_TALENT_RULES` as-is** — explicitly labeled priors; replay activation can't
   refine them. Revisit only via the planned bases-saved model.

---

## TODO #9 — Pitch-type effectiveness

League-wide (10 games, both teams). `whiff/sw` = whiffs ÷ swings; `mist%` = share flagged
`mistake`; `hit/BIP` = hits ÷ balls-in-play.

| Type | N | swing% | **whiff/sw** | called% | ball% | inPlay% | **mist%** | **hit/BIP** | avgEV |
|---|---|---|---|---|---|---|---|---|---|
| Sinker | 250 | 64 | **72** | 9 | 27 | 14 | 9 | 51 | 36.4 |
| Cutter | 356 | 65 | 65 | 12 | 22 | 21 | 10 | **51** | 38.2 |
| Slider | 350 | 66 | 65 | 10 | 24 | 20 | 8 | 59 | 38.0 |
| Splitter | 71 | 69 | 59 | 11 | 20 | 21 | 13 | 53 | 39.9 |
| 2-Seam | 223 | 62 | 59 | 10 | 28 | 22 | 10 | **66** | 38.1 |
| Curveball | 728 | 66 | 58 | 11 | 23 | 24 | 11 | 60 | 38.6 |
| 4-Seam | 291 | 66 | **34** | 9 | 25 | **40** | **54** | 59 | 37.2 |

**This is a high-whiff sim** (swing-and-miss on 58–72% of swings at breaking/offspeed). Reading:

- **Sinker is the best swing-and-miss pitch (72% whiff)** and also suppresses hits on contact
  (51% hit/BIP). **Cutter** is the most complete pitch: 65% whiff **and** lowest hit/BIP (51%).
- **Slider**: 65% whiff but hittable when contacted (59% hit/BIP).
- **Curveball** is the workhorse (728 thrown, most-used) at a solid 58% whiff.
- **2-Seam** misses fewer bats (59%) and is **the most hittable on contact (66% hit/BIP)** — a
  contact/groundball pitch, not a put-away.
- **4-Seam is the weakest put-away pitch**: 34% whiff, 40% put in play. **Caveat:** its 54%
  league mistake rate is **inflated by one low-control pitcher** (Parker Cash, 174 four-seamers at
  **81% mistake**, 16% whiff). A controlled four-seam is fine (Alonso Peterson: 15% mistake, 61%
  whiff). So the mistake stat is **pitcher-control-confounded, not intrinsic to the pitch type** —
  but even setting that aside, 4-seam's whiff rate is the lowest by a wide margin.

### Per-pitcher highlights (min 40 pitches)

- **Elliott H. Brett Jr.** (1,114 p, our ace) is elite and arsenal-deep: Sinker 73% whiff, Cutter 70%,
  Slider 65%, 2-Seam 59%, Curveball 55% — low mistake rates (7–11%) across the board.
- **Parker R. Cash** (174 p) is **4-seam-only at 81% mistakes / 16% whiff** — a glaring weakness;
  prime candidate to add a breaking pitch (Slider/Cutter/Sinker) via a pitch talent.
- **Ernie Ruiz** (Curveball 70% / Slider 76% whiff) and **Adam Verdugo** (Cutter 68% / Splitter 65%)
  are effective in small samples.
- **Angelo Polanco** and **Jefferson Aldridge** sit lower (33–48% whiff, higher mistake%).

### Batter vulnerability (min 6 swings vs a type)

Many hitters have a clear hole. Sharpest (≥45% whiff on the worst type):
- **vs Cutter:** Arnold Ruth 86% (14sw), Marty Espinosa 89%, Isiah Dozier 100% (6sw), Andy Crews 83%.
- **vs Slider:** Allen Fulmer 78%, Vincent Smith / Gregory Hader 71%, Andre McFarland 86%.
- **vs Sinker:** Pedro Hawk 88%, Angel Porter Jr. 71%, Ed Cooper 71%.
- **vs Curveball:** Omar Chapman 66% (38sw — large sample).

Caveat: most per-batter cells are 6–14 swings — directional only.

### Proposed concrete changes (TODO #9)

These metrics aren't consumed by the optimizer today; the actionable uses are advisory:

1. **Pitch-arsenal advice (AI / Talent Advisor):** rank put-away value **Sinker ≈ Cutter > Slider >
   Curveball > 2-Seam > 4-Seam** for this sim. When recommending a pitch talent, prefer
   **Sinker/Cutter** (whiff + weak contact); flag **4-Seam** as a low-whiff, contact-prone pitch and
   **2-Seam** as a contact pitch (don't expect strikeouts from it).
2. **Surface single-pitch pitchers as a weakness** (e.g., Parker Cash) — recommend adding a
   breaking/offspeed pitch.
3. **(Optional) expose pitch-type whiff/hit splits** in Advanced Stats / Replay Analysis — the
   parser already computes `PitcherEval.byType`; a per-type league baseline table would let the
   matchup AI cite batter holes ("opponent's 3-hole is 66% whiff vs sliders").
4. **Do NOT use raw `mist%` as a pitch-type quality signal** — it's dominated by pitcher control,
   not the pitch. Use whiff/sw + hit/BIP instead.

---

## Reproduce

Scratch scripts were under `scripts/_talent_*.ts` / `_pitch_eff.ts` (deleted after this writeup).
Re-derive by fetching replays (`curl … /api/replay/:id`, ≥1.5s apart, honor 429) and re-running the
contact-conditional contrast (`_talent_mech` logic) + the per-segment pitch tally (`_pitch_eff`).
The contact-conditional test is the trustworthy one for talents; raw outcome contrast is confounded.
```
