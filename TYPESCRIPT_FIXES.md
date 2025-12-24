# TypeScript Type Definition Fixes

## Problem

The `@yipe/dice` package had missing TypeScript type definitions for several key methods when consumed by external projects. This caused TypeScript errors even though the methods existed and worked correctly at runtime.

## Missing Methods (Before Fix)

1. `.ac(ac: number)` - Sets the Armor Class for attack rolls
2. `.dc(dc: number)` - Sets the Difficulty Class for saving throws
3. `.onHit(damage)` - Specifies damage dealt on a successful hit
4. `.onCrit(damage)` - Specifies additional damage dealt on a critical hit
5. `.onMiss(damage)` - Specifies damage dealt when an attack misses
6. `.onSaveFailure(damage)` - Specifies damage dealt when a saving throw fails
7. `.saveHalf()` - Indicates that on a successful save, the target takes half damage
8. `.critOn(threshold)` - Sets the critical hit threshold
9. `d(value)` - Only accepted `number`, not `string | number`

## Root Cause

The issue was caused by prototype augmentation using relative module paths (`"./roll"`) in the module augmentation declarations. These relative paths don't resolve correctly when the package is consumed externally, causing TypeScript to not recognize the augmented methods.

## Solution

Instead of using module augmentation with relative paths, the methods were added directly to the `RollBuilder` class definition with stub implementations that get overridden by the prototype augmentations at runtime.

### Changes Made

#### 1. `/src/builder/roll.ts`

Added method declarations directly to the `RollBuilder` class:

```typescript
ac(targetAC: number): import("./ac").ACBuilder {
  throw new Error("ac() should be implemented via prototype augmentation");
}

dc(saveDC: number): import("./dc").DCBuilder {
  throw new Error("dc() should be implemented via prototype augmentation");
}
```

#### 2. `/src/builder/ac.ts`

Removed the module augmentation declaration:

```typescript
// REMOVED:
// declare module "./roll" {
//   interface RollBuilder {
//     ac(targetAC: number): ACBuilder;
//   }
// }

// KEPT: Prototype augmentation
RollBuilder.prototype.ac = function (targetAC: number): ACBuilder {
  if (isNaN(targetAC)) throw new Error("Invalid NaN value for targetAC");
  return new ACBuilder(this, targetAC);
};
```

#### 3. `/src/builder/dc.ts`

Removed the module augmentation declaration:

```typescript
// REMOVED:
// declare module "./roll" {
//   interface RollBuilder {
//     dc(saveDC: number): DCBuilder;
//   }
// }

// KEPT: Prototype augmentation
RollBuilder.prototype.dc = function (saveDC: number): DCBuilder {
  if (isNaN(saveDC)) throw new Error("Invalid NaN value for saveDC");
  return new DCBuilder(this).dc(saveDC);
};
```

#### 4. `/src/builder/factory.ts`

Updated the `d()` function to accept both `number` and `string`:

```typescript
export function d(sides: number | string): RollBuilder {
  if (typeof sides === "string") {
    return RollBuilder.fromArgs(sides);
  }
  return new RollBuilder(1).d(sides);
}

// Also updated rollFn.d
rollFn.d = (sides: number | string): RollBuilder => {
  if (typeof sides === "string") {
    return RollBuilder.fromArgs(sides);
  }
  return new RollBuilder(1).d(sides);
};
```

#### 5. `/src/builder/types.ts`

Updated the `RollFactory` type:

```typescript
export type RollFactory = {
  (count: number, sides?: number, modifier?: number): RollBuilder;
  (count: number, die: RollBuilder, modifier?: number): RollBuilder;
  d(sides: number | string): RollBuilder; // Changed from: d(sides: number)
  // ... rest of the type
};
```

## Verification

All changes have been verified:

- ✅ Build succeeds (`npm run build`)
- ✅ All 1055 tests pass (`npm test`)
- ✅ TypeScript type checking passes (`npm run typecheck`)
- ✅ Generated type definitions include all methods in `/dist/builder/index.d.ts`

## Generated Type Definitions

The generated `/dist/builder/index.d.ts` now correctly includes:

```typescript
declare class RollBuilder {
  // ... other methods ...
  ac(targetAC: number): ACBuilder;
  dc(saveDC: number): DCBuilder;
}

declare class ACBuilder extends RollBuilder {
  onHit(val: number): AttackBuilder;
  onHit(val: string): AttackBuilder;
  onHit(val: RollBuilder): AttackBuilder;
  // ... other overloads ...
  critOn(threshold: number): ACBuilder;
}

declare class AttackBuilder implements CheckBuilder {
  onCrit(val: number): AttackBuilder;
  onCrit(val: string): AttackBuilder;
  onCrit(val: RollBuilder): AttackBuilder;
  // ... other overloads ...
  onMiss(val: number): AttackBuilder;
  onMiss(val: string): AttackBuilder;
  onMiss(val: RollBuilder): AttackBuilder;
  // ... other overloads ...
}

declare class DCBuilder extends RollBuilder {
  onSaveFailure(val: number): SaveBuilder;
  onSaveFailure(val: string): SaveBuilder;
  onSaveFailure(val: RollBuilder): SaveBuilder;
  // ... other overloads ...
}

declare class SaveBuilder implements CheckBuilder {
  saveHalf(): SaveBuilder;
}

declare function d(sides: number | string): RollBuilder;
```

## Usage Examples

All of these now work correctly with TypeScript:

```typescript
import { d20, d, roll } from "@yipe/dice/builder";

// Attack rolls
const attack = d20.plus(5).ac(20).onHit("2d6+3").onCrit("2d6").onMiss(5);

// Champion fighter with expanded crit range
const champion = d20.plus(5).ac(20).critOn(19).onHit("1d8+4");

// Saving throws
const fireball = d20.plus(3).dc(15).onSaveFailure("8d6").saveHalf();

// String parsing
const parsedDice = d("2d6+3");
const rollParsed = roll.d("2d6+3");
```
