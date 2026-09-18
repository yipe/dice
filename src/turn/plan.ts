import { EPS } from "../common/types";
import { PMF } from "../pmf/pmf";
import type {
  Attack,
  Damage,
  Rider,
  Trigger,
  TurnSpec,
  TurnSpecErrorCode,
} from "./types";
import { MAX_TRIGGER_GROUPS, TurnSpecError } from "./types";

/**
 * A resolved, validated turn: the ordered steps to walk, plus the trigger
 * groups it tracks. Building this is where every {@link TurnSpecError} is raised,
 * so the walk itself can assume a well-formed plan.
 */
export interface TurnPlan {
  steps: readonly Step[];
  /** One entry per distinct `of` set; each holds the step indices that update it. */
  groupCount: number;
  /** Declared attacks only, in order — what `DiceQuery.singles` gets. */
  attackPMFs: readonly PMF[];
  /** Every attack id, in declaration order. */
  attackIds: readonly string[];
  /** Every rider id, in declaration order, including `every-hit` riders. */
  riderIds: readonly string[];
  /** Rider id → step index, for `fireProbability` and `not-fired`. */
  riderSteps: ReadonlyMap<string, number>;
  /**
   * `every-hit` rider id → the group index whose "something landed" bit answers
   * P(it fired at least once). Such riders are folded into their sources' slices
   * rather than becoming steps, so they have no step index.
   */
  perHitGroups: ReadonlyMap<string, number>;
}

/**
 * One step of the turn. `slices` non-null ⇒ the step rolls its own attack and
 * advances the groups listed in `updates`; null ⇒ it is pure damage whose amount
 * depends only on the mode it fires in.
 */
export interface Step {
  id: string;
  /** Declared attacks always fire; riders consult their trigger. */
  trigger: Trigger | null;
  /** Outcome-labelled sub-mass PMFs, masses summing to 1. */
  slices: { hit: PMF; crit: PMF; miss: PMF } | null;
  /** Pure-damage payloads, mass 1 each. */
  damage: { hit: PMF; crit: PMF } | null;
  /** Group indices this step's outcome advances. */
  updates: readonly number[];
  /** Group index this step's trigger reads, or -1 for `not-fired` / always-fires. */
  reads: number;
  /** For `not-fired`: the step index of the rider being negated. */
  negates: number;
}

const IS_HIT_TRIGGER: Record<string, true> = {
  "first-hit": true,
  "any-crit": true,
  "any-miss": true,
  "every-hit": true,
};

function toPMF(damage: Damage | readonly Damage[], eps: number): PMF {
  const parts = Array.isArray(damage) ? damage : [damage as Damage];
  if (parts.length === 0) return PMF.delta(0, eps);
  const pmfs = parts.map((part) =>
    part instanceof PMF ? part : part.toPMF(eps)
  );
  return PMF.convolveMany(pmfs, eps);
}

/**
 * Crit payload for a rider: an explicit `critDamage` wins; otherwise double the
 * dice if the builder supports it. `ParsedRollBuilder.doubleDice()` throws (a
 * parsed expression has no AST to scale) and a raw `PMF` has no dice to double,
 * so both fall back to the base damage — the same rule `AttackBuilder.resolve`
 * already applies to `onHit` without an `onCrit`.
 */
function critPMF(rider: Rider, base: PMF, eps: number): PMF {
  if (rider.critDamage !== undefined) return toPMF(rider.critDamage, eps);

  const parts = Array.isArray(rider.damage)
    ? rider.damage
    : [rider.damage as Damage];
  const doubled: PMF[] = [];
  for (const part of parts) {
    const doublable = part as { doubleDice?: () => Damage };
    if (part instanceof PMF || typeof doublable.doubleDice !== "function") {
      return base;
    }
    try {
      doubled.push(toPMF(doublable.doubleDice(), eps));
    } catch {
      return base;
    }
  }
  return PMF.convolveMany(doubled, eps);
}

/**
 * Split a source into hit / crit / miss sub-mass PMFs, or return null when the
 * PMF carries no outcome labels (a plain damage roll is not an attack).
 */
function sliceSource(pmf: PMF): { hit: PMF; crit: PMF; miss: PMF } | null {
  const labels = pmf.outcomes();
  if (!labels.includes("hit") && !labels.includes("crit")) return null;

  const missParts = ["missNone", "missDamage"]
    .filter((label) => labels.includes(label))
    .map((label) => pmf.filterOutcome(label));

  return {
    hit: labels.includes("hit") ? pmf.filterOutcome("hit") : PMF.emptyMass(),
    crit: labels.includes("crit") ? pmf.filterOutcome("crit") : PMF.emptyMass(),
    miss: missParts.length
      ? missParts.reduce((all, part) => all.add(part))
      : PMF.emptyMass(),
  };
}

export function buildPlan(spec: TurnSpec, eps: number = EPS): TurnPlan {
  const fail = (code: TurnSpecErrorCode, id: string, message: string): never => {
    throw new TurnSpecError(code, id, message);
  };

  // --- attacks -------------------------------------------------------------
  const attackIds: string[] = [];
  const attackPMFs: PMF[] = [];
  const attackSlices: ({ hit: PMF; crit: PMF; miss: PMF } | null)[] = [];

  spec.attacks.forEach((entry: Attack, index) => {
    const named = entry as { id?: string; source?: Damage };
    const hasWrapper =
      typeof named.id === "string" && named.source !== undefined;
    const id = hasWrapper ? (named.id as string) : `attack ${index + 1}`;
    const source = hasWrapper ? (named.source as Damage) : (entry as Damage);
    const pmf = toPMF(source, eps);

    attackIds.push(id);
    attackPMFs.push(pmf);
    attackSlices.push(sliceSource(pmf));
  });

  const riders = spec.riders ?? [];

  // --- ids -----------------------------------------------------------------
  const riderIds = riders.map((rider, index) => rider.id ?? `rider ${index + 1}`);
  const seen = new Set<string>();
  for (const id of [...attackIds, ...riderIds]) {
    if (seen.has(id)) fail("duplicate-id", id, `Duplicate id "${id}".`);
    seen.add(id);
  }

  const attackIndexById = new Map(attackIds.map((id, index) => [id, index]));
  const riderIndexById = new Map(riderIds.map((id, index) => [id, index]));

  // --- references ----------------------------------------------------------
  // `of` lists for hit triggers, defaulted to every declared attack.
  const sourceIdsByRider: string[][] = riders.map((rider, index) => {
    const id = riderIds[index];

    if (rider.on === "not-fired") {
      const target = rider.of;
      if (target === id) {
        fail("self-reference", id, `Rider "${id}" cannot depend on itself.`);
      }
      const targetIndex = riderIndexById.get(target);
      if (targetIndex === undefined) {
        fail(
          "unknown-id",
          target,
          `Rider "${id}" negates "${target}", which is not a rider in this turn.`
        );
      }
      if (riders[targetIndex as number].on === "every-hit") {
        fail(
          "not-an-attack",
          target,
          `Rider "${id}" negates "${target}", an every-hit rider, which can fire more than once and so has no single "did not fire" branch.`
        );
      }
      return [target];
    }

    // Deduplicated, so `of: ["a", "a"]` shares a trigger group with `of: ["a"]`
    // instead of consuming a second slot and tripping `too-many-groups` on a
    // turn that is really tracking one source set. Repeats are otherwise
    // harmless: advancing a group twice for one outcome is idempotent.
    const of = [...new Set(rider.of ?? attackIds)];
    if (of.length === 0) {
      fail("unknown-id", id, `Rider "${id}" has no sources.`);
    }
    for (const sourceId of of) {
      if (sourceId === id) {
        fail("self-reference", id, `Rider "${id}" cannot depend on itself.`);
      }
      const riderIndex = riderIndexById.get(sourceId);
      const isAttack = attackIndexById.has(sourceId);
      if (!isAttack && riderIndex === undefined) {
        fail(
          "unknown-id",
          sourceId,
          `Rider "${id}" depends on "${sourceId}", which is not in this turn.`
        );
      }
      if (riderIndex !== undefined && riders[riderIndex].on === "every-hit") {
        fail(
          "not-an-attack",
          sourceId,
          `Rider "${id}" triggers on "${sourceId}", an every-hit rider. Those are folded into their own sources rather than resolved separately, so they cannot be triggered on — point at the attacks instead.`
        );
      }
      const slices = isAttack
        ? attackSlices[attackIndexById.get(sourceId) as number]
        : sliceSource(toPMF(riders[riderIndex as number].damage, eps));
      if (!slices) {
        fail(
          "not-an-attack",
          sourceId,
          `Rider "${id}" triggers on "${sourceId}", which has no hit/crit outcomes.`
        );
      }
    }
    return [...of];
  });

  // --- ordering ------------------------------------------------------------
  // Riders may only reference riders that resolve before them.
  const order: number[] = [];
  const visiting = new Set<number>();
  const done = new Set<number>();

  const visit = (index: number): void => {
    if (done.has(index)) return;
    const id = riderIds[index];
    if (visiting.has(index)) {
      fail("cycle", id, `Rider "${id}" is part of a dependency cycle.`);
    }
    visiting.add(index);
    for (const sourceId of sourceIdsByRider[index]) {
      const dependency = riderIndexById.get(sourceId);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(index);
    done.add(index);
    order.push(index);
  };
  riders.forEach((_, index) => visit(index));

  // --- groups --------------------------------------------------------------
  // One group per distinct source set. Sharing matters: sneak attack and Fire's
  // Burn over the same two daggers are ONE group, so they resolve jointly.
  const groupIndexByKey = new Map<string, number>();
  const groupSources: string[][] = [];
  const groupOf = (sourceIds: readonly string[]): number => {
    // JSON, not a delimiter join: an id is consumer-supplied, and a delimiter
    // that can appear inside one makes the encoding non-injective, so two
    // distinct source sets could share a group.
    const key = JSON.stringify([...sourceIds].sort());
    const existing = groupIndexByKey.get(key);
    if (existing !== undefined) return existing;
    if (groupSources.length >= MAX_TRIGGER_GROUPS) {
      fail(
        "too-many-groups",
        key,
        `A turn may track at most ${MAX_TRIGGER_GROUPS} distinct trigger source sets.`
      );
    }
    const index = groupSources.length;
    groupIndexByKey.set(key, index);
    groupSources.push([...sourceIds]);
    return index;
  };

  const readsByRider = new Map<number, number>();
  const perHitGroups = new Map<string, number>();
  for (const index of order) {
    const rider = riders[index];
    if (!IS_HIT_TRIGGER[rider.on]) continue;
    const group = groupOf(sourceIdsByRider[index]);
    readsByRider.set(index, group);
    if (rider.on === "every-hit") perHitGroups.set(riderIds[index], group);
  }

  // --- steps ---------------------------------------------------------------
  // `every-hit` riders are not steps: they are convolved into each source's own
  // hit/crit slices, so one hit means one application with no extra state.
  const perHitBySource = new Map<string, { hit: PMF; crit: PMF }[]>();
  for (const index of order) {
    const rider = riders[index];
    if (rider.on !== "every-hit") continue;
    const hit = toPMF(rider.damage, eps);
    const payload = { hit, crit: critPMF(rider, hit, eps) };
    for (const sourceId of sourceIdsByRider[index]) {
      const existing = perHitBySource.get(sourceId);
      if (existing) existing.push(payload);
      else perHitBySource.set(sourceId, [payload]);
    }
  }

  const updatesById = new Map<string, number[]>();
  groupSources.forEach((sourceIds, groupIndex) => {
    for (const sourceId of sourceIds) {
      const existing = updatesById.get(sourceId);
      if (existing) existing.push(groupIndex);
      else updatesById.set(sourceId, [groupIndex]);
    }
  });

  const withPerHit = (
    slices: { hit: PMF; crit: PMF; miss: PMF },
    id: string
  ): { hit: PMF; crit: PMF; miss: PMF } => {
    const payloads = perHitBySource.get(id);
    if (!payloads) return slices;
    let hit = slices.hit;
    let crit = slices.crit;
    for (const payload of payloads) {
      hit = hit.convolve(payload.hit, eps, true);
      crit = crit.convolve(payload.crit, eps, true);
    }
    return { hit, crit, miss: slices.miss };
  };

  const steps: Step[] = attackIds.map((id, index) => ({
    id,
    trigger: null,
    slices: withPerHit(
      attackSlices[index] ?? {
        hit: attackPMFs[index],
        crit: PMF.emptyMass(),
        miss: PMF.emptyMass(),
      },
      id
    ),
    damage: null,
    updates: updatesById.get(id) ?? [],
    reads: -1,
    negates: -1,
  }));

  const stepIndexByRider = new Map<number, number>();
  const riderSteps = new Map<string, number>();

  for (const index of order) {
    const rider = riders[index];
    if (rider.on === "every-hit") continue;

    const id = riderIds[index];
    const hit = toPMF(rider.damage, eps);
    const slices = sliceSource(hit);
    if (slices && rider.critDamage !== undefined) {
      // An attack-shaped rider rolls its own d20 and crits on its own terms —
      // a bonus attack triggered by a crit does not deal doubled dice — so
      // there is nothing for `critDamage` to mean. Silently dropping it would
      // hide a real misunderstanding.
      fail(
        "unused-crit-damage",
        id,
        `Rider "${id}" rolls its own attack, so its critDamage would never be used. Remove it, or pass plain damage dice instead.`
      );
    }
    const negatedRider =
      rider.on === "not-fired"
        ? (riderIndexById.get(rider.of) as number)
        : undefined;

    const step: Step = {
      id,
      trigger: rider,
      slices: slices ? withPerHit(slices, id) : null,
      damage: slices ? null : { hit, crit: critPMF(rider, hit, eps) },
      updates: updatesById.get(id) ?? [],
      reads: readsByRider.get(index) ?? -1,
      negates:
        negatedRider === undefined
          ? -1
          : (stepIndexByRider.get(negatedRider) as number),
    };
    steps.push(step);

    stepIndexByRider.set(index, steps.length - 1);
    riderSteps.set(id, steps.length - 1);
  }

  return {
    steps,
    groupCount: groupSources.length,
    attackPMFs,
    attackIds,
    riderIds,
    riderSteps,
    perHitGroups,
  };
}
