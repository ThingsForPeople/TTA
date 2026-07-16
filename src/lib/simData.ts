export const POSITION_GUIDANCE: Record<string, string> = {
  C: 'Bat-first spot. Steal defense is the only measured skill and it only weakly tracks ARM (~0.5 attempts/game); blocking/framing are unmeasured. Real C value: hitting + battery talents / Pop Time.',
  SS: 'SPD + FLD equal (range dominates in sim). ARM for long throw from the hole to 1B.',
  CF: 'SPD primary (most ground to cover). FLD for tracking, ARM for throws to home/3B.',
  '2B': 'FLD + SPD (DP pivot, range up the middle). Some ARM value — not zero.',
  '3B': 'ARM primary (hard-hit balls, long throw across diamond). FLD for hot corner, SPD for bunts.',
  RF: 'ARM + FLD + SPD balanced (longest OF throw to 3B, gap coverage, range).',
  LF: 'SPD + FLD for range and catches. ARM less critical — bat-first OF spot.',
  '1B': 'FLD primary (scooping throws). SPD for stretches. ARM minimal. Least defensive.',
};
