// How far the probabilities of one answer may add up from 1, for a model's
// answer (src/models/normalize.ts) and a test case's (src/cases.ts), so a
// case cannot pass with an answer the engine would refuse. Rounding by the
// backend: up to half a hundredth per option (eight options of 0.125 rounded
// to 0.13 add up to 1.04), at least 0.02 and at most 0.1. No imports: the
// profile tools load this file under Node.js too.

export function sumMargin(options: number): number {
  return Math.min(0.1, Math.max(0.02, options * 0.005));
}

/** Whether probabilities for `options` options add up to 1; 1e-9 is only the error of adding floating-point numbers. */
export function addsUpToOne(values: number[], options: number): boolean {
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.abs(sum - 1) <= sumMargin(options) + 1e-9;
}
