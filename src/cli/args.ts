import { InvalidArgumentError } from "commander";

/** Commander option parser for whole numbers >= 1; rejects "abc", "0", "1.5" instead of passing NaN on. */
export function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a whole number, 1 or more.");
  return n;
}
