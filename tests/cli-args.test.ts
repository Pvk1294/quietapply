import { describe, expect, it } from "vitest";
import { positiveInt } from "../src/cli/args.js";

describe("positiveInt", () => {
  it("accepts whole numbers of 1 or more", () => {
    expect(positiveInt("1")).toBe(1);
    expect(positiveInt("4777")).toBe(4777);
  });

  it("rejects text, zero, negatives and decimals instead of passing NaN on", () => {
    for (const bad of ["abc", "", "0", "-3", "1.5"])
      expect(() => positiveInt(bad), bad).toThrow(/whole number/);
  });
});
