import { describe, expect, it } from "vitest";
import { CROSS_RUNTIME_TOLERANCE, hex, readFixture, toleranceFor, withinTolerance } from "./format";

describe("compat tolerance by runtime", () => {
  it("on the capture's Node major, pmf, mean and toQuery are bit-exact and the mass-walk readers 1e-12", () => {
    for (const reader of ["pmf", "mean", "toQuery"]) expect(toleranceFor(reader, true)).toBeUndefined();
    for (const reader of ["fireProbability", "expectedApplications", "stepStats"]) expect(toleranceFor(reader, true)).toBe(1e-12);
  });

  it("on another Node major, every reader is compared at 1e-12 relative", () => {
    expect(CROSS_RUNTIME_TOLERANCE).toBe(1e-12);
    for (const reader of ["pmf", "mean", "toQuery", "fireProbability", "expectedApplications", "stepStats"]) {
      expect(toleranceFor(reader, false)).toBe(CROSS_RUNTIME_TOLERANCE);
    }
  });

  it("a 2 ULP difference is not bit-equal but passes at 1e-12", () => {
    const want = hex(18.25);
    const got = hex(18.25 + 2 * Number.EPSILON * 16);
    expect(got).not.toBe(want);
    expect(withinTolerance(want, got, CROSS_RUNTIME_TOLERANCE)).toBe(true);
  });

  it("the fixture records the Node major it was captured on", () => {
    expect(readFixture().capturedOn).toBe(24);
  });
});
