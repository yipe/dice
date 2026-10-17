/** The randomness a sampler draws from. `die(n)` is uniform on 1..n; `chance(p)` is true with probability p. */
export interface Rng {
  die(sides: number): number;
  chance(p: number): boolean;
}
