export const POSITION_GUIDANCE: Record<string, string> = {
  C: 'ARM primary (steal prevention). FLD for blocking and exchange speed. SPD less critical.',
  SS: 'SPD + FLD equal (range dominates in sim). ARM for long throw from the hole to 1B.',
  CF: 'SPD primary (most ground to cover). FLD for tracking, ARM for throws to home/3B.',
  '2B': 'FLD + SPD (DP pivot, range up the middle). Some ARM value — not zero.',
  '3B': 'ARM primary (hard-hit balls, long throw across diamond). FLD for hot corner, SPD for bunts.',
  RF: 'ARM + FLD + SPD balanced (longest OF throw to 3B, gap coverage, range).',
  LF: 'SPD + FLD for range and catches. ARM less critical — bat-first OF spot.',
  '1B': 'FLD primary (scooping throws). SPD for stretches. ARM minimal. Least defensive.',
};
