import { describe, expect, it } from 'vitest';
import { buildClientPermissions, buildOperatorPermissions, buildRoleCalls } from '../src/setup-roles.js';
import { processPermissions } from 'zodiac-roles-sdk';
import { Interface } from 'ethers';
import {
  MERKLE_DROP_ADDRESS,
  MULTI_SEND_CALL_ONLY_ADDRESS,
  ROLES_MODIFIER_V2_SINGLETON,
  SAFE_TOKEN_ADDRESS,
  STAKING_CONTRACT_ADDRESS,
} from '../src/constants.js';

const ROLES_IFACE = new Interface([
  'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
]);

const CLIENT = {
  safe: '0x03d4969997a6f6cf8b8695c33087aa175a8463d6',
  rolesModifier: '0x1111111111111111111111111111111111111111', // deployed proxy
  roleKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  validator: '0x2222222222222222222222222222222222222222',
  feeBps: 2500,
};

const OPERATOR = {
  safe: '0x0000000000000000000000000000000000000004',
  rolesModifier: '0x3333333333333333333333333333333333333333', // deployed proxy
  roleKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  validator: '0x4444444444444444444444444444444444444444',
};

const EXECUTOR = '0x7D97161910151c19d8655194772E88B01D4CdB6c';
const ROLE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

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

  it('targets the deployed proxy for all scoping calls, never the singleton', async () => {
    const calls = await buildRoleCalls(
      CLIENT.safe,
      CLIENT.rolesModifier,
      ROLE_KEY,
      EXECUTOR,
      buildClientPermissions(CLIENT, OPERATOR.safe),
    );

    // Tx 0: enableModule on the Safe, enabling the proxy.
    expect(calls[0]!.to.toLowerCase()).toBe(CLIENT.safe.toLowerCase());
    expect(calls[0]!.data.slice(0, 10)).toBe('0x610b5925'); // enableModule
    expect(calls[0]!.data.slice(10)).toContain(CLIENT.rolesModifier.slice(2).toLowerCase());

    // Every subsequent call must target the proxy, not the singleton.
    for (const call of calls.slice(1)) {
      expect(call.to.toLowerCase()).toBe(CLIENT.rolesModifier.toLowerCase());
      expect(call.to.toLowerCase()).not.toBe(ROLES_MODIFIER_V2_SINGLETON.toLowerCase());
    }

    // assignRoles must grant membership to the EXECUTOR, not the proxy.
    const assign = calls.find((c) => c.data.startsWith('0x957ed2b3'))!;
    expect(assign.to.toLowerCase()).toBe(CLIENT.rolesModifier.toLowerCase());
    const decoded = ROLES_IFACE.decodeFunctionData('assignRoles', assign.data);
    expect(decoded.module.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(decoded.module.toLowerCase()).not.toBe(CLIENT.rolesModifier.toLowerCase());
  });

  it('operator role calls target the operator proxy and assign the executor', async () => {
    const calls = await buildRoleCalls(
      OPERATOR.safe,
      OPERATOR.rolesModifier,
      ROLE_KEY,
      EXECUTOR,
      buildOperatorPermissions(OPERATOR),
    );
    expect(calls[0]!.to.toLowerCase()).toBe(OPERATOR.safe.toLowerCase());
    for (const call of calls.slice(1)) {
      expect(call.to.toLowerCase()).toBe(OPERATOR.rolesModifier.toLowerCase());
      expect(call.to.toLowerCase()).not.toBe(ROLES_MODIFIER_V2_SINGLETON.toLowerCase());
    }
    const assign = calls.find((c) => c.data.startsWith('0x957ed2b3'))!;
    const decoded = ROLES_IFACE.decodeFunctionData('assignRoles', assign.data);
    expect(decoded.module.toLowerCase()).toBe(EXECUTOR.toLowerCase());
  });

  it('omits enableModule in skip mode', async () => {
    const calls = await buildRoleCalls(
      CLIENT.safe,
      CLIENT.rolesModifier,
      ROLE_KEY,
      EXECUTOR,
      buildClientPermissions(CLIENT, OPERATOR.safe),
      'skip',
    );
    expect(calls.some((c) => c.data.startsWith('0x610b5925'))).toBe(false);
    expect(calls[0]!.data.slice(0, 10)).toBe('0x0c6c76b8'); // scopeTarget first
  });

  it('includes enableModule in always mode', async () => {
    const calls = await buildRoleCalls(
      CLIENT.safe,
      CLIENT.rolesModifier,
      ROLE_KEY,
      EXECUTOR,
      buildClientPermissions(CLIENT, OPERATOR.safe),
      'always',
    );
    expect(calls[0]!.data.slice(0, 10)).toBe('0x610b5925'); // enableModule
  });
});
