import { describe, expect, it } from 'vitest';
import { computeSplit } from '../src/index.js';

describe('computeSplit', () => {
  it('splits 25% fee / 75% restake at 2500 bps', () => {
    const { feeAmount, restakeAmount } = computeSplit(10000n, 2500);
    expect(feeAmount).toBe(2500n);
    expect(restakeAmount).toBe(7500n);
  });

  it('routes 100% to fee at 10000 bps', () => {
    const { feeAmount, restakeAmount } = computeSplit(12345n, 10000);
    expect(feeAmount).toBe(12345n);
    expect(restakeAmount).toBe(0n);
  });

  it('routes 0% to fee at 0 bps', () => {
    const { feeAmount, restakeAmount } = computeSplit(12345n, 0);
    expect(feeAmount).toBe(0n);
    expect(restakeAmount).toBe(12345n);
  });

  it('never creates dust: fee + restake == delta', () => {
    for (const delta of [1n, 7n, 999n, 1000000000000000000n]) {
      for (const bps of [0, 1, 2500, 3333, 9999, 10000]) {
        const { feeAmount, restakeAmount } = computeSplit(delta, bps);
        expect(feeAmount + restakeAmount).toBe(delta);
      }
    }
  });
});
