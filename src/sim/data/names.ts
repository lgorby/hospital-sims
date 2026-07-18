import type { SeededRng } from '../rng';

/** Procedural people names (GDD §3) — deliberately warm, a little
 *  Theme-Hospital silly. Owner ask 2026-07-18: MORE fun names. Expanding
 *  these pools changes which names seeded rng picks (intBelow(length)) but
 *  NOT the draw count — the rng stream is otherwise untouched, and no test
 *  pins a literal generated name (grepped before the expansion). */
const FIRST_NAMES = [
  'Doris', 'Earl', 'Marge', 'Stanley', 'Pearl', 'Vern', 'Agnes', 'Chester',
  'Ida', 'Floyd', 'Ruthie', 'Mel', 'Opal', 'Gus', 'Blanche', 'Homer',
  'Sadie', 'Wally', 'Edna', 'Bert', 'Flo', 'Ned', 'Gladys', 'Rufus',
  'Maribel', 'Otis', 'Lucille', 'Amos', 'Twyla', 'Cyrus', 'Nadine', 'Percy',
  'Priya', 'Marcus', 'Yolanda', 'Dmitri', 'Keisha', 'Santiago', 'Mei', 'Kofi',
  'Bernice', 'Clyde', 'Mabel', 'Horace', 'Winnie', 'Lester', 'Fanny', 'Basil',
  'Petunia', 'Wilbur', 'Greta', 'Norbert', 'Dottie', 'Ernie', 'Prudence', 'Alvin',
  'Roz', 'Mortimer', 'Hattie', 'Seymour', 'Bea', 'Reginald', 'Cora', 'Virgil',
  'Ingrid', 'Ravi', 'Consuela', 'Bjorn', 'Fatima', 'Giuseppe', 'Anka', 'Tobias',
] as const;

const LAST_NAMES = [
  'Klepper', 'Womble', 'Pickering', 'Snodgrass', 'Buttersby', 'Cragg',
  'Dimple', 'Fothergill', 'Grubbs', 'Hornbuckle', 'Jessop', 'Knapp',
  'Limpkin', 'Mudd', 'Noodleman', 'Ollivander', 'Pratt', 'Quimby',
  'Rumford', 'Splint', 'Throckmorton', 'Umbridge', 'Vole', 'Wexler',
  'Yarrow', 'Zink', 'Okafor', 'Reyes', 'Nakamura', 'Petrov',
  'Bumbleford', 'Crumpet', 'Dandywine', 'Figgins', 'Gristle', 'Higginbottom',
  'Inkwell', 'Jitters', 'Kettleworth', 'Lollygag', 'Mumford', 'Nettlebed',
  'Puddifoot', 'Quibble', 'Rattlesby', 'Sneed', 'Tumbler', 'Wobblesworth',
  'Fiddlesticks', 'Ganderpoke', 'Bristlecone', 'Marmalade', 'Ozturk', 'Delacroix',
] as const;

export interface PersonName {
  first: string;
  last: string;
  /** "Doris Klepper" */
  full: string;
  /** "Doris K." — for compact UI like the thought log. */
  short: string;
}

export function generateName(rng: SeededRng): PersonName {
  const first = FIRST_NAMES[rng.intBelow(FIRST_NAMES.length)]!;
  const last = LAST_NAMES[rng.intBelow(LAST_NAMES.length)]!;
  return { first, last, full: `${first} ${last}`, short: `${first} ${last[0]}.` };
}

export function generateAge(rng: SeededRng): number {
  const MIN_AGE = 4;
  const MAX_AGE = 94;
  return MIN_AGE + rng.intBelow(MAX_AGE - MIN_AGE + 1);
}

/**
 * Staff are working-age (Expansion-1 QA fix: the shared 4–94 generator could
 * mint an age-4 surgeon). Deliberately consumes EXACTLY one rng draw, the same
 * as generateAge — swapping generators must not shift the seeded rng stream
 * any further than the range change itself.
 */
export function generateStaffAge(rng: SeededRng): number {
  const MIN_AGE = 22;
  const MAX_AGE = 68;
  return rng.intInRange(MIN_AGE, MAX_AGE);
}
