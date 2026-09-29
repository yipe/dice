// Runs in a child `node` process against a BUILT package (`node entry-probe.mjs <dist> <esm|cjs>`), so
// it sees the two entries exactly as a consumer's runtime does. Prints one JSON object: what the
// two entries' PMF and Mixture classes are to each other, and the mean of every Turn a PMF (or a
// Mixture's PMF) made by the ROOT entry joins through the `/builder` entry's `turn()`.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dist, format] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const load = async (entry) =>
  format === "esm"
    ? import(pathToFileURL(path.join(dist, `${entry}.js`)).href)
    : require(path.join(dist, `${entry}.cjs`));

const root = await load("index");
const builder = await load("builder/index");
const { PMF, Mixture, parse, DiceParseError } = root;
const { d, d20, d4, turn } = builder;

/** A mean, or the `TurnSpecError` code a refusal carries. */
const observe = (build) => {
  try {
    return { mean: build().mean() };
  } catch (error) {
    return { error: error.code ?? String(error) };
  }
};

// d20 + 8 vs AC 16 with 1d4 + 4: 12/20 plain hits at 6.5 and 1/20 crit at 9, so a mean of 4.35.
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const fromBuilder = dagger.toPMF();

// The same attack as a root-entry PMF: parsed by the root entry.
const parsedDagger = parse("(d20 + 8 AC 16) * (1d4 + 4)");

// A labelled attack mixture from the root entry's `Mixture`: 5 on a hit, 10 on a crit.
const mixtureAttack = (M) =>
  new M()
    .add("hit", PMF.delta(5), 0.6)
    .add("crit", PMF.delta(10), 0.05)
    .add("missNone", PMF.delta(0), 0.35)
    .buildPMF();

let parseError = null;
try {
  d("1d");
} catch (error) {
  parseError = error;
}

console.log(
  JSON.stringify({
    identity: {
      // `instanceof` in both directions, and the very same constructor.
      builderPmfIsRootPmf: fromBuilder instanceof PMF,
      rootPmfIsBuilderPmf: PMF.delta(1) instanceof fromBuilder.constructor,
      turnPmfIsRootPmf: turn([dagger]).pmf instanceof PMF,
      sameConstructor: fromBuilder.constructor === PMF,
      // `/builder` exports the root's `Mixture`, not a copy.
      builderMixtureIsRootMixture: builder.Mixture === Mixture,
      builderMixturePmfIsRootPmf:
        typeof builder.Mixture === "function" && mixtureAttack(builder.Mixture) instanceof PMF,
      // Errors thrown through one entry are the other entry's classes too.
      builderParseErrorIsRootError: parseError instanceof DiceParseError,
    },
    accepted: {
      bareAttack: observe(() => turn([dagger])),
      rootPmfAsAttack: observe(() => turn([dagger, PMF.delta(3)])),
      rootParsedAttackAsSource: observe(() => turn([parsedDagger]).onFirstHit(PMF.delta(3))),
      rootMixtureAttackAsSource: observe(() => turn([mixtureAttack(Mixture)]).onFirstHit(PMF.delta(3))),
      builderMixtureAttackAsSource: observe(() =>
        turn([mixtureAttack(builder.Mixture)]).onFirstHit(PMF.delta(3))
      ),
      rootPmfAsRider: observe(() => turn([dagger]).onFirstHit(PMF.delta(3))),
      rootPmfListAsRider: observe(() => turn([dagger]).onFirstHit([PMF.delta(1), PMF.delta(2)])),
      rootPmfAsCritDamage: observe(() =>
        turn([dagger]).onAnyCrit(PMF.delta(2), { critDamage: PMF.delta(5) })
      ),
      toPMFReturningRootPmf: observe(() => turn([dagger]).onFirstHit({ toPMF: () => PMF.delta(3) })),
    },
  })
);
