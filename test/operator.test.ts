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

import { checkRoleConfigured } from '../src/index.js';
import { JsonRpcProvider } from 'ethers';

describe('checkRoleConfigured', () => {
  it('reports missing targets when role storage is empty', async () => {
    // Mock provider: getStorage returns zero for every slot.
    const provider = {
      getStorage: async () => '0x' + '00'.repeat(32),
    } as unknown as JsonRpcProvider;
    const r = await checkRoleConfigured(
      '0x1111111111111111111111111111111111111111',
      '0x' + '11'.repeat(32),
      provider,
      ['0x40A2aCCbd92BCA938b02010E17A5b8929b49130D'],
      [{ target: '0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2', selector: '0x1d7d4ebc' }],
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(2);
    expect(r.found).toHaveLength(0);
  });

  it('reports found targets when role storage is populated', async () => {
    const provider = {
      getStorage: async () => '0x' + '00'.repeat(31) + '01', // clearance=1, options=0
    } as unknown as JsonRpcProvider;
    const r = await checkRoleConfigured(
      '0x1111111111111111111111111111111111111111',
      '0x' + '11'.repeat(32),
      provider,
      ['0x40A2aCCbd92BCA938b02010E17A5b8929b49130D'],
      [],
    );
    expect(r.ok).toBe(true);
    expect(r.found).toHaveLength(1);
    expect(r.missing).toHaveLength(0);
  });
});
