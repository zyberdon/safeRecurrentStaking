import { describe, expect, it } from 'vitest';
import { buildOperatorCalls } from '../src/index.js';
import { STAKING_CONTRACT_ADDRESS, SAFE_TOKEN_ADDRESS } from '../src/constants.js';

const OPERATOR = {
  safe: '0x0000000000000000000000000000000000000004',
  rolesModifier: '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5',
  roleKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  validator: '0x0000000000000000000000000000000000000006',
};

describe('buildOperatorCalls', () => {
  it('builds approve + stake for the full liquid balance', () => {
    const { calls, stakedAmount } = buildOperatorCalls(OPERATOR, 12345n);
    expect(stakedAmount).toBe(12345n);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to.toLowerCase()).toBe(SAFE_TOKEN_ADDRESS.toLowerCase());
    expect(calls[0]!.data.slice(0, 10)).toBe('0x095ea7b3'); // approve
    expect(calls[1]!.to.toLowerCase()).toBe(STAKING_CONTRACT_ADDRESS.toLowerCase());
    expect(calls[1]!.data.slice(0, 10)).toBe('0xadc9772e'); // stake
  });

  it('returns no calls when balance is zero', () => {
    const { calls, stakedAmount } = buildOperatorCalls(OPERATOR, 0n);
    expect(stakedAmount).toBe(0n);
    expect(calls).toHaveLength(0);
  });
});
