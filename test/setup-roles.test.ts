import { describe, expect, it } from 'vitest';
import { buildClientPermissions, buildOperatorPermissions } from '../src/setup-roles.js';
import { processPermissions } from 'zodiac-roles-sdk';
import {
  MERKLE_DROP_ADDRESS,
  MULTI_SEND_CALL_ONLY_ADDRESS,
  SAFE_TOKEN_ADDRESS,
  STAKING_CONTRACT_ADDRESS,
} from '../src/constants.js';

const CLIENT = {
  safe: '0x03d4969997a6f6cf8b8695c33087aa175a8463d6',
  rolesModifier: '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5',
  roleKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  validator: '0x1111111111111111111111111111111111111111',
  feeBps: 2500,
};

const OPERATOR = {
  safe: '0x0000000000000000000000000000000000000004',
  rolesModifier: '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5',
  roleKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  validator: '0x2222222222222222222222222222222222222222',
};

describe('setup-roles permissions', () => {
  it('client permissions include multisend delegatecall, claim, transfer, approve, stake', () => {
    const { targets } = processPermissions(buildClientPermissions(CLIENT, OPERATOR.safe));
    const byAddress = new Map(targets.map((t) => [t.address.toLowerCase(), t]));

    const ms = byAddress.get(MULTI_SEND_CALL_ONLY_ADDRESS.toLowerCase())!;
    expect(ms.clearance).toBe(1); // Target
    expect(ms.executionOptions).toBe(2); // DelegateCall

    const drop = byAddress.get(MERKLE_DROP_ADDRESS.toLowerCase())!;
    expect(drop.clearance).toBe(2); // Function
    expect(drop.functions[0]!.selector).toBe('0x1d7d4ebc'); // claim
    expect(drop.functions[0]!.wildcarded).toBe(false);

    const token = byAddress.get(SAFE_TOKEN_ADDRESS.toLowerCase())!;
    const selectors = token.functions.map((f) => f.selector);
    expect(selectors).toContain('0xa9059cbb'); // transfer
    expect(selectors).toContain('0x095ea7b3'); // approve

    const staking = byAddress.get(STAKING_CONTRACT_ADDRESS.toLowerCase())!;
    expect(staking.functions[0]!.selector).toBe('0xadc9772e'); // stake
  });

  it('operator permissions include multisend delegatecall, claim, approve, stake (no transfer)', () => {
    const { targets } = processPermissions(buildOperatorPermissions(OPERATOR));
    const byAddress = new Map(targets.map((t) => [t.address.toLowerCase(), t]));

    const ms = byAddress.get(MULTI_SEND_CALL_ONLY_ADDRESS.toLowerCase())!;
    expect(ms.executionOptions).toBe(2);

    const drop = byAddress.get(MERKLE_DROP_ADDRESS.toLowerCase())!;
    expect(drop.functions[0]!.selector).toBe('0x1d7d4ebc');

    const token = byAddress.get(SAFE_TOKEN_ADDRESS.toLowerCase())!;
    const selectors = token.functions.map((f) => f.selector);
    expect(selectors).toContain('0x095ea7b3');
    expect(selectors).not.toContain('0xa9059cbb'); // operator never transfers

    const staking = byAddress.get(STAKING_CONTRACT_ADDRESS.toLowerCase())!;
    expect(staking.functions[0]!.selector).toBe('0xadc9772e');
  });
});
