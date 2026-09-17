import "../src/builder/ac";
import "../src/builder/dc";
import { d10, d20, d4, d6, d8, roll } from "../src/builder/factory";
import { turn } from "../src/turn";
import { printSummary } from "./print";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));

/**
 * Sneak Attack: 3d6 once per turn, on the first dagger that lands. Doubled when
 * that first landing attack was a crit.
 */
function sneakAttack() {
  const rogue = turn([dagger, dagger]).onFirstHit(roll(3, d6));

  printSummary("Rogue: two daggers + Sneak Attack", rogue.query());
  console.log("P(whiff turn):", rogue.pmf.pAt(0).toFixed(4));
}

/**
 * Hunter's Mark fires on EVERY hit, so with two attacks it applies about 1.5x as
 * often as a once-per-turn rider — not 2x, because two attacks land at least once
 * most of the time.
 */
function perHitVersusOncePerTurn() {
  const attacks = turn([dagger, dagger]);
  const mark = turn([dagger, dagger]).onEveryHit(d6, { id: "mark" });
  const sneak = turn([dagger, dagger]).onFirstHit(d6);

  console.log("\nBase two daggers      :", attacks.mean().toFixed(4));
  console.log("+ 1d6 every hit       :", mark.mean().toFixed(4));
  console.log("+ 1d6 once per turn   :", sneak.mean().toFixed(4));
  console.log("P(mark fires at all)  :", mark.fireProbability("mark").toFixed(4));
}

/**
 * The hard case: a goliath rogue/monk/paladin. Smite needs a crit; the flurry of
 * blows happens precisely when the smite did not, so the two are mutually
 * exclusive rather than independent.
 */
function goliathRogueMonkPaladin() {
  const flurry = d20.plus(8).ac(16).onHit(d6.plus(4));

  const goliath = turn([dagger, dagger])
    .onFirstHit(roll(3, d6)) // sneak attack
    .onFirstHit(d10) // fire's burn
    // Only `smite` and `flurry` are named, because the lines below ask about
    // them by name; `otherwise` itself finds its target without an id.
    .onAnyCrit(roll(2, d8), { id: "smite" })
    .otherwise([flurry, flurry], { id: "flurry" })
    .onEveryHit(d6);

  printSummary("Goliath rogue/monk/paladin", goliath.query());
  console.log("P(smite) :", goliath.fireProbability("smite").toFixed(4));
  console.log("P(flurry):", goliath.fireProbability("flurry").toFixed(4));
  console.log(
    "exclusive:",
    (
      goliath.fireProbability("smite") + goliath.fireProbability("flurry")
    ).toFixed(10)
  );
}

/**
 * Kensei's Unerring Accuracy rerolls one miss per turn, which is exactly a fresh
 * attack gated on "something missed".
 */
function unerringAccuracy() {
  const monk = turn([dagger, dagger]).onAnyMiss(dagger, { id: "reroll" });

  console.log("\nWith a once-per-turn miss reroll:", monk.mean().toFixed(4));
  console.log("P(reroll used):", monk.fireProbability("reroll").toFixed(4));
}

sneakAttack();
perHitVersusOncePerTurn();
goliathRogueMonkPaladin();
unerringAccuracy();
