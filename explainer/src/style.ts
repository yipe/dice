import type { CSSProperties, FC } from "react";

export type DieProps = { value: number; size: number; highlight?: boolean; ghost?: boolean };
export type CellProps = { a: number; b: number; sum: number; size: number; highlight?: boolean; dim?: boolean };
export type SlotProps = { w: number; h: number; highlight: boolean; filled: number };

export type Style = {
  id: string;
  fonts: { display: string; body: string; mono: string };
  colors: { fg: string; muted: string; accent: string; highlight: string; surface: string; border: string };
  /** Fill for a 2d6 cell / histogram block by its sum, so colour carries the "which total" idea. */
  sumColor: (sum: number) => string;
  Background: FC;
  Die: FC<DieProps>;
  /** Solid colour inside the 3D die, visible only at its rounded edges. */
  dieCore: string;
  Cell: FC<CellProps>;
  Slot: FC<SlotProps>;
  /** Spring feel for every move: precise vs bouncy vs hand-placed. */
  spring: { damping: number; stiffness: number; mass: number };
  captionStyle: CSSProperties;
  /** Optional overlay rendered above everything (texture, wobble filter defs). */
  Overlay?: FC;
  /** CSS filter applied to the whole stage (e.g. hand-drawn wobble). */
  stageFilter?: string;
};

// Pip positions on a 3x3 grid, standard die layout.
export const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};
