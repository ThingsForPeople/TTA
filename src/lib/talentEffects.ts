// AUTO-DERIVED from Tiny Teams replay data (GET /api/replay/:gameId).
// Maps each talent's DISPLAY NAME to the internal engine stat key(s) its
// effect modifies. These are the real simulation "levers" — distinct from
// the 7 displayed sim stats (CON/POW/SPD/FLD/ARM/PIT/STA).
//
// IMPORTANT: replay effects carry tier + polarity but NO magnitude, so this
// records WHAT a talent touches, not how much. Coverage is limited to talents
// observed active in sampled replays; an absent talent simply didn't fire
// in those games (it is not "effect-less"). The join key is the display name
// because replay talent IDs embed pitch type (e.g. zone:slider:high:whiffs)
// while talents.ts uses pitch-agnostic IDs. Re-extend via scripts/audit-talents.ts.
//
// A talent's engine effect is its PAYOFF, which can differ from its TRIGGER.
// e.g. "Pressure Cooker" pays off as line_drive+power but only after building
// charges on outs-with-runners-on -- so it is still a runners-on lineup talent.

export type EngineStat =
    "add_pitch"
  | "add_stealing"
  | "contact_chance"
  | "fielding_infield_speed"
  | "fielding_outfield_speed"
  | "fielding_release_band_shift"
  | "fielding_release_time_boost"
  | "fielding_throw_speed"
  | "fielding_throw_variance"
  | "fly_ball_chance"
  | "foul_chance"
  | "grounder_chance"
  | "homerun_chance"
  | "line_drive_chance"
  | "pitch_crit_chance"
  | "pitch_mistake_chance"
  | "pitch_movement"
  | "pitch_velocity"
  | "power"
  | "runner_speed"
  | "signal"
  | "steal_success_boost"
  | "swing_chance"
  | "zone_weight"
  ;

/** Talent display name -> engine stat levers it modifies (observed). */
export const TALENT_ENGINE_EFFECTS: Record<string, EngineStat[]> = {
  "Battler": ["foul_chance", "swing_chance"],
  "Charger": ["fielding_infield_speed"],
  "Clutch": ["contact_chance", "power"],
  "Curveball": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Cutter": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Disciplined": ["swing_chance"],
  "Fastball": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Hard to Handle": ["fielding_release_band_shift", "signal"],
  "Heads & Tails": ["fielding_infield_speed"],
  "High Break": ["pitch_movement"],
  "High Chopper": ["grounder_chance"],
  "High Command": ["pitch_crit_chance"],
  "High Dialed": ["contact_chance"],
  "High Driver": ["line_drive_chance"],
  "High Popper": ["fly_ball_chance"],
  "High Punch": ["contact_chance"],
  "Hot Potato": ["fielding_release_band_shift", "fielding_release_time_boost", "fielding_throw_speed", "fielding_throw_variance"],
  "Inside Dialed": ["contact_chance"],
  "Inside Driver": ["line_drive_chance"],
  "Inside Hacker": ["swing_chance"],
  "Inside Heat": ["pitch_velocity"],
  "Inside Popper": ["fly_ball_chance"],
  "Inside Punch": ["contact_chance"],
  "Inside Sink": ["grounder_chance"],
  "Knowledge is Power": ["power"],
  "Low Aim": ["zone_weight"],
  "Low Break": ["pitch_movement"],
  "Low Chopper": ["grounder_chance"],
  "Low Dialed": ["contact_chance"],
  "Low Driver": ["line_drive_chance"],
  "Low Hacker": ["swing_chance"],
  "Low Popper": ["fly_ball_chance"],
  "Mental Warfare": ["pitch_mistake_chance"],
  "No Doubles": ["fielding_outfield_speed"],
  "Off Speed Tracker": ["contact_chance"],
  "Outside Command": ["pitch_crit_chance"],
  "Outside Dialed": ["contact_chance"],
  "Outside Driver": ["line_drive_chance"],
  "Outside Heat": ["pitch_velocity"],
  "Outside Popper": ["fly_ball_chance"],
  "Pop Time": ["steal_success_boost"],
  "Pressure Cooker": ["line_drive_chance", "power"],
  "Quick Silver": ["runner_speed"],
  "Rally Time": ["contact_chance", "pitch_mistake_chance", "power", "swing_chance"],
  "Righty Tighty": ["contact_chance", "power"],
  "Set the Tone": ["contact_chance", "power", "swing_chance"],
  "Sinker": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Slider": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Splitter": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Sweet Tooth": ["homerun_chance"],
  "Table Setter": ["contact_chance"],
  "The Janitor": ["power"],
  "Thief": ["add_stealing", "steal_success_boost"],
  "Two-Seam Fastball": ["add_pitch", "pitch_movement", "pitch_velocity"],
  "Warmed Up": ["fielding_throw_speed"],
  "Waste No Time": ["contact_chance"],
};

/** Human-readable description of every engine lever (for AI context + UI). */
export const ENGINE_STAT_GLOSSARY: Record<EngineStat, string> = {
  "add_pitch": "Adds a pitch type to the pitcher’s arsenal.",
  "add_stealing": "Unlocks stealing for the runner.",
  "contact_chance": "Chance the bat makes contact on a swing (the core hit-or-miss roll).",
  "fielding_infield_speed": "Infielder reaction/closing speed to balls in play.",
  "fielding_outfield_speed": "Outfielder reaction/closing speed to balls in play.",
  "fielding_release_band_shift": "Shifts the timing window/band for a clean fielding release.",
  "fielding_release_time_boost": "How quickly a fielder releases the throw after fielding.",
  "fielding_throw_speed": "Velocity of a fielder’s throw.",
  "fielding_throw_variance": "Accuracy spread of a fielder’s throw (lower = more accurate).",
  "fly_ball_chance": "Bias of batted-ball type toward fly balls (power/HR upside, also outs).",
  "foul_chance": "Likelihood a swing results in a foul (prolongs the at-bat, used by Battler).",
  "grounder_chance": "Bias of batted-ball type toward ground balls (situational, speed-dependent).",
  "homerun_chance": "Sweet-spot authority that converts contact into home runs.",
  "line_drive_chance": "Bias of batted-ball type toward line drives (the highest-value outcome).",
  "pitch_crit_chance": "Chance a pitch \"overpowers\" the batter (a pitcher crit).",
  "pitch_mistake_chance": "Chance the pitcher leaves a hittable mistake (raised by hitter talents, lowered by pitcher control).",
  "pitch_movement": "Pitch break/movement.",
  "pitch_velocity": "Pitch speed.",
  "power": "Exit-velocity / authority on contact — drives hit distance and gap damage.",
  "runner_speed": "Baserunning sprint speed.",
  "signal": "Battery/catcher signalling effect (steal & framing related).",
  "steal_success_boost": "Improves steal-success odds (runner) or steal prevention (catcher Pop Time).",
  "swing_chance": "Likelihood the batter offers at a pitch (aggression).",
  "zone_weight": "Shifts how often the pitcher targets a given zone (aim talents).",
};

/**
 * Directional hitting-zone effect families. The suffix word of a zone talent
 * ("High Driver" -> Driver) determines its engine effect and relative
 * offensive value. Ranking is grounded in batted-ball OUTCOME quality
 * (line drives > contact > fly balls / grounders > raw aggression), NOT in
 * magnitude (which is unknown). Used to differentiate zone talents in the
 * batting-order engine instead of treating them all identically.
 */
export type ZoneHitEffect = 'Dialed' | 'Driver' | 'Chopper' | 'Popper' | 'Hacker';
export const ZONE_HIT_EFFECT: Record<ZoneHitEffect, { engineStat: EngineStat; rank: number; note: string }> = {
  Driver: { engineStat: "line_drive_chance", rank: 5, note: "line drives -- the highest-value batted ball (replay-confirmed: +~0.3 line-drive share, +1-3 EV when active)" },
  Dialed: { engineStat: "contact_chance", rank: 4, note: "cleaner contact within the zone" },
  // Popper demoted 3->2 (2026-06-29 replay analysis): when active it shows no
  // measurable EV gain and only a weak fly-ball shift -- not the clear upgrade
  // over Chopper the old rank implied. HR upside keeps it level with, not above,
  // Chopper. (Ties are fine; rank only scales a small batting-order tiebreaker.)
  Popper: { engineStat: "fly_ball_chance", rank: 2, note: "fly balls -- some HR upside, but replay shows little contact-quality gain" },
  Chopper: { engineStat: "grounder_chance", rank: 2, note: "ground balls -- situational, rewards speed" },
  Hacker: { engineStat: "swing_chance", rank: 1, note: "more swings -- aggression, double-edged (replay: -1 to -2.6 EV, more grounders)" },
};

