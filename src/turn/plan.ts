import { EPS } from "../common/types";
import type { DiceMatchInfo, HasDiceMatchInfo } from "../common/types";
import { PMF } from "../pmf/pmf";
import type {
  Attack,
  Damage,
  Rider,
  ToPMF,
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
  /**
   * The LAST step index (in final walk order) that reads each group, by group
   * index — `steps.length` for a group `perHitGroups` still needs at the final
   * collapse. Once the walk passes a group's last reader, its specific code
   * stops discriminating any future decision, so `Turn.resolve`'s `merge` stops
   * keying on it past that point — the dominant cost fix for a long `dice-match`
   * chain (a group read by exactly one downstream step, the common shape, would
   * otherwise keep splitting states for every step after that single read).
   */
  groupLastReadStep: readonly number[];
}

/**
 * Outcome-labelled sub-mass PMFs for one source, masses summing to 1.
 *
 * `hitMatch`/`hitNoMatch`/`critMatch`/`critNoMatch` are non-null only when this
 * source is referenced by a `dice-match` trigger's `of` — computing the exact
 * per-damage match split costs a DP walk, so it is opt-in per source rather than
 * always paid. When present, `hitMatch.add(hitNoMatch) === hit` (and similarly for
 * crit) up to floating-point mass.
 */
export interface SourceSlices {
  hit: PMF;
  crit: PMF;
  miss: PMF;
  hitMatch: PMF | null;
  hitNoMatch: PMF | null;
  critMatch: PMF | null;
  critNoMatch: PMF | null;
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
  slices: SourceSlices | null;
  /** Pure-damage payloads, mass 1 each. */
  damage: { hit: PMF; crit: PMF } | null;
  /** Group indices this step's outcome advances. */
  updates: readonly number[];
  /** Group index this step's trigger reads, or -1 for `not-fired` / always-fires. */
  reads: number;
  /** For `not-fired`: the step index of the rider being negated. */
  negates: number;
}

/** Trigger kinds that read a group's accumulated state (as opposed to `not-fired`,
 * which reads another rider's fire/not-fire bit directly). */
const READS_GROUP: Record<string, true> = {
  "first-hit": true,
  "any-crit": true,
  "any-miss": true,
  "every-hit": true,
  "dice-match": true,
};

function toPMF(
  damage: Damage | readonly Damage[],
  eps: number,
  id = ""
): PMF {
  const parts = Array.isArray(damage) ? damage : [damage as Damage];
  if (parts.length === 0) return PMF.delta(0, eps);
  const pmfs = parts.map((part) => {
    if (part instanceof PMF) return part;
    // `Damage` rules this out, but a consumer deserializing UI state reaches
    // here untyped. Reporting it as a spec error beats a bare TypeError from
    // calling a method that isn't there.
    if (typeof (part as Partial<ToPMF>).toPMF !== "function") {
      throw new TurnSpecError(
        "not-an-attack",
        id,
        `"${id}" is neither a PMF nor a builder with toPMF().`
      );
    }
    // Also checked on the way out: a callable `toPMF` that returns something
    // else would otherwise reach PMF.convolveMany and fail deep inside it.
    const resolved = part.toPMF(eps);
    if (!(resolved instanceof PMF)) {
      throw new TurnSpecError(
        "not-an-attack",
        id,
        `"${id}" has a toPMF() that did not return a PMF.`
      );
    }
    return resolved;
  });
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
  if (doubled.length === 0) return base;
  return PMF.convolveMany(doubled, eps);
}

/** Duck-typed lookup of a `Damage` source's `dice-match` descriptor. Absence
 * (a bare `PMF`, or a `ToPMF` that does not implement {@link HasDiceMatchInfo})
 * is a defined "no match info" state — `{ hit: null, crit: null }` — not a crash. */
function diceMatchInfoOf(
  source: Damage,
  eps: number
): { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } {
  const capable = source as Partial<HasDiceMatchInfo>;
  if (typeof capable.diceMatchInfo === "function") {
    return capable.diceMatchInfo(eps);
  }
  return { hit: null, crit: null };
}

/**
 * Split a source into hit / crit / miss sub-mass PMFs, or return null when the
 * PMF carries no outcome labels (a plain damage roll is not an attack).
 *
 * `matchInfo` — when supplied — further splits the hit and/or crit sub-mass by
 * exact per-damage match probability (see {@link SourceSlices}). Only requested
 * for sources a `dice-match` trigger actually names.
 */
function sliceSource(
  pmf: PMF,
  matchInfo?: { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } | null
): SourceSlices | null {
  const labels = pmf.outcomes();
  if (!labels.includes("hit") && !labels.includes("crit")) return null;

  const missParts = ["missNone", "missDamage"]
    .filter((label) => labels.includes(label))
    .map((label) => pmf.filterOutcome(label));

  const hit = labels.includes("hit") ? pmf.filterOutcome("hit") : PMF.emptyMass();
  const crit = labels.includes("crit") ? pmf.filterOutcome("crit") : PMF.emptyMass();
  const miss = missParts.length
    ? missParts.reduce((all, part) => all.add(part))
    : PMF.emptyMass();

  let hitMatch: PMF | null = null;
  let hitNoMatch: PMF | null = null;
  let critMatch: PMF | null = null;
  let critNoMatch: PMF | null = null;

  if (matchInfo?.hit) {
    const info = matchInfo.hit;
    const [m, nm] = hit.splitByFactor((d) => info.matchProbabilityByDamage.get(d) ?? 0);
    hitMatch = m;
    hitNoMatch = nm;
  }
  if (matchInfo?.crit) {
    const info = matchInfo.crit;
    const [m, nm] = crit.splitByFactor((d) => info.matchProbabilityByDamage.get(d) ?? 0);
    critMatch = m;
    critNoMatch = nm;
  }

  return { hit, crit, miss, hitMatch, hitNoMatch, critMatch, critNoMatch };
}

export function buildPlan(spec: TurnSpec, eps: number = EPS): TurnPlan {
  const fail = (code: TurnSpecErrorCode, id: string, message: string): never => {
    throw new TurnSpecError(code, id, message);
  };

  const riders = spec.riders ?? [];

  // A raw pre-scan (before validation/ordering) for which source ids a `dice-match`
  // trigger names — computing an exact match split costs a DP walk, so it is only
  // ever done for sources that actually need it.
  const matchNeededSourceIds = new Set<string>();
  for (const rider of riders) {
    if (rider.on === "dice-match") {
      for (const sourceId of rider.of) matchNeededSourceIds.add(sourceId);
    }
  }

  // --- attacks -------------------------------------------------------------
  const attackIds: string[] = [];
  const attackPMFs: PMF[] = [];
  const attackSlices: (SourceSlices | null)[] = [];

  spec.attacks.forEach((entry: Attack, index) => {
    const named = entry as { id?: string; source?: Damage };
    const hasWrapper =
      typeof named.id === "string" && named.source !== undefined;
    const id = hasWrapper ? (named.id as string) : `attack ${index + 1}`;
    const source = hasWrapper ? (named.source as Damage) : (entry as Damage);
    const pmf = toPMF(source, eps, id);
    const matchInfo = matchNeededSourceIds.has(id)
      ? diceMatchInfoOf(source, eps)
      : null;

    attackIds.push(id);
    attackPMFs.push(pmf);
    attackSlices.push(sliceSource(pmf, matchInfo));
  });

  // --- ids -----------------------------------------------------------------
  const riderIds = riders.map((rider, index) => rider.id ?? `rider ${index + 1}`);
  const seen = new Set<string>();
  for (const id of [...attackIds, ...riderIds]) {
    if (seen.has(id)) fail("duplicate-id", id, `Duplicate id "${id}".`);
    seen.add(id);
  }

  const attackIndexById = new Map(attackIds.map((id, index) => [id, index]));
  const riderIndexById = new Map(riderIds.map((id, index) => [id, index]));

  /** Throws `no-dice-descriptor` if `sourceId`'s hit/crit branches (whichever
   * exist) lack the match info a `dice-match` trigger on `riderId` needs. */
  const checkMatchable = (
    riderId: string,
    sourceId: string,
    slices: SourceSlices
  ): void => {
    const missingHit = slices.hit.mass() > 0 && slices.hitMatch === null;
    const missingCrit = slices.crit.mass() > 0 && slices.critMatch === null;
    if (missingHit || missingCrit) {
      fail(
        "no-dice-descriptor",
        sourceId,
        `Rider "${riderId}" reads "${sourceId}" for "dice-match", but "${sourceId}" has no dice descriptor to match against — a bare PMF, a string-parsed expression, or a keep()/bestOf() pool (ambiguous "the dice" under crit doubling) cannot be matched.`
      );
    }
  };

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
    const of = [...new Set(rider.on === "dice-match" ? rider.of : (rider.of ?? attackIds))];
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
      const damageSource = isAttack ? undefined : riders[riderIndex as number].damage;
      const singleDamageSource: Damage | undefined =
        damageSource !== undefined && !Array.isArray(damageSource) ? (damageSource as Damage) : undefined;
      const slices = isAttack
        ? attackSlices[attackIndexById.get(sourceId) as number]
        : sliceSource(
            toPMF(damageSource as Damage | readonly Damage[], eps, sourceId),
            matchNeededSourceIds.has(sourceId) && singleDamageSource !== undefined
              ? diceMatchInfoOf(singleDamageSource, eps)
              : null
          );
      if (!slices) {
        fail(
          "not-an-attack",
          sourceId,
          `Rider "${id}" triggers on "${sourceId}", which has no hit/crit outcomes.`
        );
      } else if (rider.on === "dice-match") {
        checkMatchable(id, sourceId, slices);
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
    if (!READS_GROUP[rider.on]) continue;
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
    const hit = toPMF(rider.damage, eps, riderIds[index]);
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

  const withPerHit = (slices: SourceSlices, id: string): SourceSlices => {
    const payloads = perHitBySource.get(id);
    if (!payloads) return slices;
    let hit = slices.hit;
    let crit = slices.crit;
    let hitMatch = slices.hitMatch;
    let hitNoMatch = slices.hitNoMatch;
    let critMatch = slices.critMatch;
    let critNoMatch = slices.critNoMatch;
    for (const payload of payloads) {
      hit = hit.convolve(payload.hit, eps, true);
      crit = crit.convolve(payload.crit, eps, true);
      if (hitMatch) hitMatch = hitMatch.convolve(payload.hit, eps, true);
      if (hitNoMatch) hitNoMatch = hitNoMatch.convolve(payload.hit, eps, true);
      if (critMatch) critMatch = critMatch.convolve(payload.crit, eps, true);
      if (critNoMatch) critNoMatch = critNoMatch.convolve(payload.crit, eps, true);
    }
    return { hit, crit, miss: slices.miss, hitMatch, hitNoMatch, critMatch, critNoMatch };
  };

  const emptySlices: SourceSlices = {
    hit: PMF.emptyMass(),
    crit: PMF.emptyMass(),
    miss: PMF.emptyMass(),
    hitMatch: null,
    hitNoMatch: null,
    critMatch: null,
    critNoMatch: null,
  };

  const steps: Step[] = attackIds.map((id, index) => ({
    id,
    trigger: null,
    slices: withPerHit(
      attackSlices[index] ?? { ...emptySlices, hit: attackPMFs[index] },
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
    const hit = toPMF(rider.damage, eps, id);
    const singleRiderDamage: Damage | undefined = !Array.isArray(rider.damage) ? (rider.damage as Damage) : undefined;
    const matchInfo =
      matchNeededSourceIds.has(id) && singleRiderDamage !== undefined
        ? diceMatchInfoOf(singleRiderDamage, eps)
        : null;
    const slices = sliceSource(hit, matchInfo);
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

  // The LAST step index (in final walk order) that reads each group. Once the walk has passed
  // that step, the group's specific code stops discriminating any future decision — a group read
  // by exactly one downstream step (the common `dice-match` chain shape: group N is read only by
  // step N+1) becomes dead weight in the merge key for every step after that read. This was the
  // dominant cost in a long `bounce()` chain (measured: fixing it turned 1.8s at a 9-deep chain
  // into ~40ms). `perHitGroups` groups are read only at the very end (after every step, for
  // `every-hit` fire probability), so they stay live through the whole walk — `steps.length`
  // sentinel.
  const groupLastReadStep = new Array<number>(groupSources.length).fill(-1);
  steps.forEach((step, stepIndex) => {
    if (step.reads !== -1) {
      groupLastReadStep[step.reads] = Math.max(groupLastReadStep[step.reads], stepIndex);
    }
  });
  for (const group of perHitGroups.values()) {
    groupLastReadStep[group] = steps.length;
  }

  return {
    steps,
    groupCount: groupSources.length,
    attackPMFs,
    attackIds,
    riderIds,
    riderSteps,
    perHitGroups,
    groupLastReadStep,
  };
}
