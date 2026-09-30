import { createHash } from "node:crypto";
import type * as Builder from "../../src/builder";
import { bits, pmfBits } from "./save-half-cases";

/**
 * Random dice-match turns: a source attack with a plain pool of one kind of die (with a `minimum`
 * or a `reroll` on it, a flat, an explicit or no crit, a separate channel, attack-level rerolls),
 * read by a `dice-match` chain, rider or attack-shaped follow-on. Every shape here has a dice-match
 * descriptor in 0.15.0, so `fingerprint` of the shape reads the same off any build that keeps that
 * behaviour: `dice-match-golden.json` holds the digests 0.15.0 gave.
 */

/** The builder entry a shape is built with: the branch's own, or another build's (a differential run). */
export type BuilderApi = typeof Builder;

export interface Group {
  count: number;
  sides: 4 | 6 | 8 | 10 | 12;
  minimum: number;
  reroll: number;
}

export interface Shape {
  group: Group;
  modifier: number;
  crit: "auto" | "none" | "explicit";
  channel: boolean;
  rerollDamage: number;
  minimumDamageDie: number;
  check: "ac" | "alwaysHits" | "advantage";
  bonus: number;
  ac: number;
  turn: "bounce" | "rider" | "attack rider" | "two attacks";
  bounceMax: number;
}

/** A small deterministic generator (mulberry32), so a shape is a function of its index alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shapeAt(index: number): Shape {
  const next = rng(0x9e3779b9 ^ Math.imul(index + 1, 0x85ebca6b));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const sides = pick([4, 6, 8, 8, 8, 10, 12] as const);
  const minimum = pick([0, 0, 0, 2, 3]);
  return {
    group: {
      count: pick([1, 2, 2, 3, 3, 3, 4, 5, 6]),
      sides,
      minimum,
      reroll: pick([0, 0, 0, 1, 2]),
    },
    modifier: pick([0, 0, 1, 3, 5]),
    crit: pick(["auto", "auto", "auto", "auto", "none", "explicit"] as const),
    channel: next() < 0.25,
    rerollDamage: pick([0, 0, 0, 0, 1, 2]),
    minimumDamageDie: pick([0, 0, 0, 0, 2, 3]),
    check: pick(["ac", "ac", "ac", "alwaysHits", "advantage"] as const),
    bonus: pick([0, 3, 5, 7, 9]),
    ac: pick([8, 12, 15, 17, 20, 24]),
    turn: pick(["bounce", "bounce", "rider", "attack rider", "two attacks"] as const),
    bounceMax: pick([1, 2, 3]),
  };
}

/** The shape's source attack. */
export function attackOf(api: BuilderApi, shape: Shape): Builder.AttackBuilder {
  const { d4, d6, d8, d10, d12, d20, roll } = api;
  const die = { 4: d4, 6: d6, 8: d8, 10: d10, 12: d12 }[shape.group.sides];
  const faces = die.reroll(shape.group.reroll).minimum(shape.group.minimum);
  const payload = roll(shape.group.count, faces).plus(shape.modifier);
  const check =
    shape.check === "alwaysHits"
      ? d20.alwaysHits()
      : shape.check === "advantage"
        ? d20.withAdvantage().plus(shape.bonus).ac(shape.ac)
        : d20.plus(shape.bonus).ac(shape.ac);
  let attack = check.onHit(payload);
  if (shape.crit === "none") attack = attack.noCrit();
  if (shape.crit === "explicit") attack = attack.onCrit(roll(2 * shape.group.count + 1, faces).plus(shape.modifier));
  if (shape.channel) attack = attack.plusSeparateDamage(roll(1, d6));
  if (shape.rerollDamage > 0) attack = attack.rerollDamage(shape.rerollDamage);
  if (shape.minimumDamageDie > 0) attack = attack.minimumDamageDie(shape.minimumDamageDie);
  return attack;
}

/** The shape's turn: the source and what reads its dice. */
export function turnOf(api: BuilderApi, shape: Shape): Builder.Turn {
  const { bounce, d6, d8, d20, roll, turn } = api;
  const source = attackOf(api, shape);
  switch (shape.turn) {
    case "bounce":
      return bounce({ source, max: shape.bounceMax });
    case "rider":
      return turn(source).onDiceMatch(["attack 1"], roll(2, d6).plus(1), { id: "on match" });
    case "attack rider":
      return turn(source).onDiceMatch(["attack 1"], d20.plus(6).ac(14).onHit(roll(2, d8)), { id: "follow" });
    case "two attacks":
      return turn([source, d20.plus(4).ac(15).onHit(roll(1, d8))]).onDiceMatch(["attack 1"], roll(1, d8), {
        id: "on match",
      });
  }
}

function mapBits(map: ReadonlyMap<number, number> | undefined): unknown {
  if (map === undefined) return null;
  return [...map].sort(([a], [b]) => a - b).map(([damage, p]) => [damage, bits(p)]);
}

/** Everything a consumer reads off the shape's dice-match descriptor and turn, bit for bit. */
export function fingerprint(api: BuilderApi, shape: Shape): string {
  const source = attackOf(api, shape);
  const info = source.diceMatchInfo();
  const t = turnOf(api, shape);
  const signature = {
    hit: mapBits(info.hit?.matchProbabilityByDamage),
    crit: mapBits(info.crit?.matchProbabilityByDamage),
    pmf: pmfBits(t.pmf),
  };
  return createHash("sha256").update(JSON.stringify(signature)).digest("hex");
}
