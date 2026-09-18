import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d20, d4, d6, roll } from "../src/builder/factory";
import { Turn, turn, TurnSpecError } from "../src/turn";
import { MAX_TRIGGER_GROUPS } from "../src/turn/types";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));

function codeOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof TurnSpecError) return error.code;
    throw error;
  }
  throw new Error("expected a TurnSpecError");
}

describe("TurnSpecError codes", () => {
  it("unknown-id: a trigger names something that is not in the turn", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [{ id: "sneak", damage: d6, on: "first-hit", of: ["gone"] }],
        })
      )
    ).toBe("unknown-id");
  });

  it("unknown-id: not-fired names something that is not a rider", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [{ damage: d6, on: "not-fired", of: "d1" }],
        })
      )
    ).toBe("unknown-id");
  });

  it("duplicate-id", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [
            { id: "d1", source: dagger },
            { id: "d1", source: dagger },
          ],
        })
      )
    ).toBe("duplicate-id");
  });

  it("self-reference", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [{ id: "sneak", damage: d6, on: "not-fired", of: "sneak" }],
        })
      )
    ).toBe("self-reference");
  });

  it("cycle", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [
            { id: "a", damage: d6, on: "not-fired", of: "b" },
            { id: "b", damage: d6, on: "not-fired", of: "a" },
          ],
        })
      )
    ).toBe("cycle");
  });

  it("not-an-attack: a hit trigger names a pure-damage rider", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [
            { id: "sneak", damage: roll(3, d6), on: "first-hit" },
            { id: "extra", damage: d6, on: "first-hit", of: ["sneak"] },
          ],
        })
      )
    ).toBe("not-an-attack");
  });

  it("too-many-groups", () => {
    const attacks = Array.from({ length: MAX_TRIGGER_GROUPS + 1 }, (_, i) => ({
      id: `a${i}`,
      source: dagger,
    }));
    expect(
      codeOf(() =>
        Turn.from({
          attacks,
          riders: attacks.map((attack, i) => ({
            id: `r${i}`,
            damage: d6,
            on: "first-hit" as const,
            of: [attack.id],
          })),
        })
      )
    ).toBe("too-many-groups");
  });

  it("fireProbability throws unknown-id for a non-rider", () => {
    const built = turn([dagger]).rider({ id: "sneak", damage: d6, on: "first-hit" });
    expect(built.fireProbability("sneak")).toBeGreaterThan(0);
    expect(codeOf(() => built.fireProbability("attack 1"))).toBe("unknown-id");
  });
});

describe("Turn ids and defaults", () => {
  it("names bare attacks in declaration order", () => {
    const built = turn([dagger, dagger]).rider({
      id: "sneak",
      damage: d6,
      on: "first-hit",
      of: ["attack 2"],
    });
    // Only the second dagger can trigger it, so it fires on that attack alone.
    expect(built.fireProbability("sneak")).toBeCloseTo(0.65, 10);
  });

  it("defaults `of` to every declared attack", () => {
    const explicit = turn([dagger, dagger]).rider({
      id: "sneak",
      damage: d6,
      on: "first-hit",
      of: ["attack 1", "attack 2"],
    });
    const defaulted = turn([dagger, dagger]).rider({
      id: "sneak",
      damage: d6,
      on: "first-hit",
    });
    expect(defaulted.mean()).toBeCloseTo(explicit.mean(), 12);
  });

  it("shares one group between riders with the same sources", () => {
    // Two riders on the same trigger keep the mean of the independent build but
    // not its spread: they fire together or not at all.
    const shared = turn([dagger, dagger])
      .rider({ damage: roll(3, d6), on: "first-hit" })
      .rider({ damage: d6, on: "first-hit" });
    const split = turn([dagger, dagger]).rider({
      damage: [roll(3, d6), d6],
      on: "first-hit",
    });
    expect(shared.mean()).toBeCloseTo(split.mean(), 10);
    expect(shared.pmf.stdev()).toBeCloseTo(split.pmf.stdev(), 10);
  });

  it("reuses an explicit critDamage instead of doubling", () => {
    const built = turn([dagger, dagger]).rider({
      damage: d6,
      critDamage: roll(10, d6),
      on: "any-crit",
    });
    const attacks = turn([dagger, dagger]);
    expect(built.mean() - attacks.mean()).toBeCloseTo(0.0975 * 35, 8);
  });

  it("falls back to single dice on a crit when damage cannot be doubled", () => {
    const flat = turn([dagger, dagger]).rider({
      damage: d6.pmf,
      on: "any-crit",
    });
    const attacks = turn([dagger, dagger]);
    expect(flat.mean() - attacks.mean()).toBeCloseTo(0.0975 * 3.5, 8);
  });
});

describe("Turn attribution", () => {
  it("keeps outcome labels on the exact turn PMF", () => {
    const built = turn([dagger, dagger]).rider({
      damage: roll(3, d6),
      on: "first-hit",
    });
    expect(built.pmf.outcomes().sort()).toEqual(["crit", "hit", "missNone"]);
  });

  it("produces a usable attribution chart model", () => {
    const model = turn([dagger, dagger])
      .rider({ damage: roll(3, d6), on: "first-hit" })
      .toQuery()
      .damageAttributionChartModel();
    expect(model.outcomes.length).toBeGreaterThan(0);
    expect(model.mean).toBeCloseTo(18.6225, 4);
  });
});

describe("every-hit riders cannot be referenced", () => {
  // They are folded into their own sources' slices rather than resolved as a
  // step, so a trigger pointing at one used to build fine and contribute zero.
  it("rejects not-fired against an every-hit rider", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [
            { id: "mark", damage: d6, on: "every-hit" },
            { damage: d6, on: "not-fired", of: "mark" },
          ],
        })
      )
    ).toBe("not-an-attack");
  });

  it("rejects a hit trigger against an every-hit rider, even an attack-shaped one", () => {
    const bonus = d20.plus(8).ac(16).onHit(d6.plus(4));
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [
            { id: "bonus", damage: bonus, on: "every-hit" },
            { damage: d6, on: "first-hit", of: ["bonus"] },
          ],
        })
      )
    ).toBe("not-an-attack");
  });

  it("still allows referencing a non-every-hit rider", () => {
    const built = Turn.from({
      attacks: [{ id: "d1", source: dagger }],
      riders: [
        { id: "smite", damage: d6, on: "any-crit" },
        { id: "fallback", damage: d6, on: "not-fired", of: "smite" },
      ],
    });
    expect(
      built.fireProbability("smite") + built.fireProbability("fallback")
    ).toBeCloseTo(1, 10);
  });
});

describe("Turn with source PMFs whose mass is not 1", () => {
  it("normalizes fire probabilities along with the distribution", () => {
    const lopsided = dagger.pmf.scaleMass(0.5);
    const built = turn([lopsided]).rider({
      id: "sneak",
      damage: d6,
      on: "first-hit",
    });
    const reference = turn([dagger]).rider({
      id: "sneak",
      damage: d6,
      on: "first-hit",
    });

    expect(built.pmf.mass()).toBeCloseTo(1, 10);
    // Scaling every source's mass cannot change a conditional probability.
    expect(built.fireProbability("sneak")).toBeCloseTo(
      reference.fireProbability("sneak"),
      10
    );
    expect(built.fireProbability("sneak")).toBeLessThanOrEqual(1);
  });
});

describe("trigger source sets", () => {
  it("treats a repeated source id as one source", () => {
    const attacks = [
      { id: "a", source: dagger },
      { id: "b", source: dagger },
    ];
    const plain = turn(attacks).onFirstHit(d6, { of: ["a", "b"] });
    const repeated = turn(attacks).onFirstHit(d6, { of: ["a", "b", "b", "a"] });

    expect(repeated.mean()).toBeCloseTo(plain.mean(), 12);
    expect(repeated.pmf.stdev()).toBeCloseTo(plain.pmf.stdev(), 12);
  });

  it("does not spend a trigger group on a duplicate-only difference", () => {
    const attacks = [
      { id: "a", source: dagger },
      { id: "b", source: dagger },
    ];
    // ["a"] and ["a","a"] name the same set, so these are 3 groups, not 5.
    let built = turn(attacks);
    for (const of of [["a"], ["a", "a"], ["b"], ["b", "b"], ["a", "b"]]) {
      built = built.onFirstHit(d6, { of });
    }
    expect(built.mean()).toBeGreaterThan(0);
  });

  it("keeps distinct source sets apart when an id contains the delimiter", () => {
    const attacks = [
      { id: "a\u0000b", source: dagger },
      { id: "a", source: dagger },
      { id: "b", source: dagger },
    ];
    const joined = turn(attacks).onFirstHit(d6, { of: ["a\u0000b"] });
    const pair = turn(attacks).onFirstHit(d6, { of: ["a", "b"] });

    // One source vs two: the second fires more often, so they must not share.
    expect(pair.mean()).toBeGreaterThan(joined.mean());
  });

  it("ignores later mutation of a caller-owned attacks array", () => {
    const attacks = [{ id: "a", source: dagger }];
    const built = turn(attacks).onFirstHit(d6, { of: ["a"] });
    const before = built.mean();

    attacks.push({ id: "b", source: dagger });
    expect(built.mean()).toBeCloseTo(before, 12);
    expect(built.toQuery().singles).toHaveLength(1);
  });
});

describe("validation timing", () => {
  it("throws at the call that introduced the mistake, not at pmf access", () => {
    const built = turn([dagger]);
    // Before: this returned a Turn and blew up later, at .mean().
    expect(() => built.onFirstHit(d6, { of: ["nope"] })).toThrow(TurnSpecError);
  });

  it("validates every construction path the same way", () => {
    expect(codeOf(() => turn([dagger]).onFirstHit(d6, { of: ["x"] }))).toBe(
      "unknown-id"
    );
    expect(
      codeOf(() => turn([dagger]).rider({ damage: d6, on: "first-hit", of: ["x"] }))
    ).toBe("unknown-id");
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [{ id: "d1", source: dagger }],
          riders: [{ damage: d6, on: "first-hit", of: ["x"] }],
        })
      )
    ).toBe("unknown-id");
  });
});

describe("id accessors", () => {
  it("names bare attacks and anonymous riders in declaration order", () => {
    const built = turn([dagger, dagger])
      .onFirstHit(d6)
      .onAnyCrit(d6, { id: "smite" })
      .onEveryHit(d6);

    expect(built.attackIds).toEqual(["attack 1", "attack 2"]);
    expect(built.riderIds).toEqual(["rider 1", "smite", "rider 3"]);
  });

  it("accepts every listed rider id in fireProbability", () => {
    const built = turn([dagger, dagger]).onFirstHit(d6).onEveryHit(d6);
    for (const id of built.riderIds) {
      expect(built.fireProbability(id)).toBeGreaterThan(0);
    }
  });

  it("names the available riders when given an attack id", () => {
    const built = turn([dagger]).onAnyCrit(d6, { id: "smite" });
    expect(() => built.fireProbability("attack 1")).toThrow(/Riders: "smite"/);
  });
});

describe("critDamage on an attack-shaped rider", () => {
  it("is rejected rather than silently dropped", () => {
    const greatsword = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    expect(
      codeOf(() =>
        turn([greatsword, greatsword]).onAnyCrit(greatsword, {
          critDamage: roll(20, d6),
        })
      )
    ).toBe("unused-crit-damage");
  });

  it("is still honoured for plain damage dice", () => {
    const built = turn([dagger, dagger]).onAnyCrit(d6, {
      critDamage: roll(10, d6),
    });
    expect(built.mean() - turn([dagger, dagger]).mean()).toBeCloseTo(
      0.0975 * 35,
      8
    );
  });
});
