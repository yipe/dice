// config/eslint-no-discarded-builder.fixture.ts
//
// Fixture for config/eslint-no-discarded-builder.test.ts. The rule matches on
// static type *name*, so these stand-ins for the five watched builder types
// do not need to be — and, to keep this fixture isolated from the real
// project's type-check surface, deliberately are not — the production
// classes from ../src. Every line meant to be flagged is marked `VIOLATION`;
// every other statement exercises an escape hatch (assignment, return,
// `void`, or a genuinely non-builder type) and must stay silent.

export class PMF {
  plus(n: number): PMF {
    void n;
    return new PMF();
  }
}

export class RollBuilder {
  plus(n: number): RollBuilder {
    void n;
    return new RollBuilder();
  }
  resolve(): PMF {
    return new PMF();
  }
}

export class ACBuilder extends RollBuilder {
  copy(): ACBuilder {
    return new ACBuilder();
  }
}

export class AttackBuilder {
  onHit(effect: RollBuilder): AttackBuilder {
    void effect;
    return new AttackBuilder();
  }
}

export class Turn {
  onFirstHit(effect: RollBuilder): Turn {
    void effect;
    return new Turn();
  }
  mean(): number {
    return 0;
  }
}

function makeTurn(): Turn {
  return new Turn();
}

function makePmf(): PMF {
  return new PMF();
}

function maybeTurn(spent: boolean): Turn | undefined {
  return spent ? new Turn() : undefined;
}

function sideEffect(): void {
  // A genuinely void-returning function — never a builder, never flagged.
}

export function violations(
  t: Turn,
  p: PMF,
  r: RollBuilder,
  a: AttackBuilder,
  ac: ACBuilder,
): void {
  t.onFirstHit(r); // VIOLATION Turn
  p.plus(1); // VIOLATION PMF
  r.plus(1); // VIOLATION RollBuilder
  a.onHit(r); // VIOLATION AttackBuilder
  ac.copy(); // VIOLATION ACBuilder
  makeTurn(); // VIOLATION Turn
  makePmf(); // VIOLATION PMF
  maybeTurn(true); // VIOLATION Turn (via `Turn | undefined` union descent)
}

export function cleanEscapes(t: Turn, p: PMF, r: RollBuilder, ac: ACBuilder): number {
  const kept = t.onFirstHit(r); // assignment — captured, not discarded
  void p.plus(1); // explicit `void` — acknowledged discard
  let rebound: ACBuilder;
  rebound = ac.copy(); // plain assignment (not a declaration) — still captured
  sideEffect(); // plain void-returning function — never a builder
  const total = 1 + 2; // ordinary arithmetic — never a builder
  return kept.mean() + rebound.copy().mean() + total;
}
