/**
 * One-time Zodiac Roles permission generator.
 *
 * Generates Safe Transaction Builder JSON files (one per Safe) that grant the
 * automation's `roleKey` the exact permissions needed by the reward sweep:
 *
 *   Client Safes:
 *     - delegate-call MultiSendCallOnly (the batch entry point)
 *     - CumulativeMerkleDrop.claim        (account == client Safe)
 *     - SAFE.transfer                     (to == OPERATOR_SAFE.safe)
 *     - SAFE.approve                      (spender == STAKING_CONTRACT)
 *     - Staking.stake                     (validator == client.validator)
 *
 *   Operator Safe:
 *     - delegate-call MultiSendCallOnly
 *     - CumulativeMerkleDrop.claim        (account == operator Safe)
 *     - SAFE.approve                      (spender == STAKING_CONTRACT)
 *     - Staking.stake                     (validator == operator.validator)
 *
 * Staking permissions are included in the initial setup even when
 * DEFAULT_FEE_BPS=10000 so changing the fee percentage later requires zero
 * on-chain re-signing.
 *
 * The generated JSON files are imported into the Safe Transaction Builder
 * (https://app.safe.global) and executed by the Safe owners. The executor EOA
 * must be added as a member of the role (assignRoles) in the same batch.
 *
 * Usage:
 *   node dist/setup-roles.js [--out DIR] [--role-key LABEL_OR_BYTES32]
 *   (reads CLIENT_SAFES_JSON / OPERATOR_SAFE_JSON / EXECUTOR_PRIVATE_KEY
 *    from the environment; the executor address is derived from the key)
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { c, encodeKey, flattenCondition, processPermissions } from 'zodiac-roles-sdk';
import {
  MERKLE_DROP_ADDRESS,
  MULTI_SEND_CALL_ONLY_ADDRESS,
  MULTI_SEND_SELECTOR,
  MULTI_SEND_UNWRAPPER_ADDRESS,
  ROLES_MODIFIER_V2_SINGLETON,
  SAFE_TOKEN_ADDRESS,
  STAKING_CONTRACT_ADDRESS,
} from './constants.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import type { ClientSafeConfig, OperatorSafeConfig } from './types.js';

/** Safe v1.3.0 ABI (isModuleEnabled) for defensive module checks. */
const SAFE_IFACE = new Interface(['function isModuleEnabled(address module) view returns (bool)']);

/** How to handle the enableModule step. */
export type EnableModuleMode = 'always' | 'skip' | 'auto';

/** Roles Modifier v2 function signatures (verified against the singleton ABI). */
const ROLES_IFACE = new Interface([
  'function enableModule(address module)',
  'function allowTarget(bytes32 roleKey, address targetAddress, uint8 options)',
  'function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, tuple(uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)',
  'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
  'function setTransactionUnwrapper(address to, bytes4 selector, address adapter)',
]);

const MERKLE_DROP_IFACE = new Interface([
  'function claim(address account, uint256 cumulativeAmount, bytes32 expectedMerkleRoot, bytes32[] merkleProof)',
]);

const SAFE_TOKEN_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const STAKING_IFACE = new Interface(['function stake(address validator, uint256 amount)']);

/** Selectors used in the permission conditions. */
const SELECTORS = {
  claim: MERKLE_DROP_IFACE.getFunction('claim')!.format('sighash'),
  transfer: SAFE_TOKEN_IFACE.getFunction('transfer')!.format('sighash'),
  approve: SAFE_TOKEN_IFACE.getFunction('approve')!.format('sighash'),
  stake: STAKING_IFACE.getFunction('stake')!.format('sighash'),
} as const;

/** Safe Transaction Builder JSON shape. */
export interface SafeTxBuilderFile {
  version: string;
  chainId: string;
  createdAt: number;
  meta: { name: string; description: string; txBuilderVersion: string; createdFromSafeAddress: string; createdFromOwnerAddress: string };
  transactions: Array<{
    to: string;
    value: string;
    data: string | null;
    contractMethod?: { inputs: Array<{ internalType: string; name: string; type: string }>; name: string; payable: boolean };
    contractInputsValues?: Record<string, string>;
  }>;
}

/**
 * Build the Roles Modifier permission calls for one Safe.
 *
 * `rolesModifier` is the DEPLOYED PROXY address for this Safe (from
 * CLIENT_SAFES_JSON / OPERATOR_SAFE_JSON) — NOT the master-copy singleton
 * 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5. All scoping calls
 * (scopeTarget / scopeFunction / assignRoles) must target the proxy, because
 * the singleton's owner is the deployer and calling it reverts with
 * OwnableUnauthorizedAccount.
 */
export async function buildRoleCalls(
  safe: string,
  rolesModifier: string,
  roleKey: string,
  executor: string,
  permissions: Parameters<typeof processPermissions>[0],
  enableModuleMode: EnableModuleMode = 'always',
  provider?: JsonRpcProvider,
): Promise<Array<{ to: string; value: string; data: string }>> {
  if (rolesModifier.toLowerCase() === ROLES_MODIFIER_V2_SINGLETON.toLowerCase()) {
    throw new Error(
      `rolesModifier for ${safe} is the master-copy singleton ${ROLES_MODIFIER_V2_SINGLETON}. ` +
      'Provide the DEPLOYED proxy address for this Safe in CLIENT_SAFES_JSON / OPERATOR_SAFE_JSON.',
    );
  }
  const { targets } = processPermissions(permissions);
  const calls: Array<{ to: string; value: string; data: string }> = [];

  // 1) Enable the Safe's deployed Roles Modifier proxy as a module on the Safe
  //    (unless the module is already enabled / the user opted to skip).
  const needsEnable = async (): Promise<boolean> => {
    if (enableModuleMode === 'skip') return false;
    if (enableModuleMode === 'always') return true;
    // 'auto'
    if (!provider) {
      logger.warn(`No provider for auto module check on ${safe}; defaulting to include enableModule`);
      return true;
    }
    try {
      const safeContract = new Contract(safe, SAFE_IFACE, provider);
      const enabled = await safeContract.isModuleEnabled!(rolesModifier);
      if (enabled) {
        logger.info(`Module ${rolesModifier} already enabled on ${safe}; omitting enableModule`);
        return false;
      }
      logger.info(`Module ${rolesModifier} not enabled on ${safe}; including enableModule`);
      return true;
    } catch (err) {
      logger.warn(`isModuleEnabled check failed for ${safe}: ${(err as Error).message}; including enableModule`);
      return true;
    }
  };

  if (await needsEnable()) {
    calls.push({
      to: safe,
      value: '0',
      data: ROLES_IFACE.encodeFunctionData('enableModule', [rolesModifier]),
    });
  }

  // 2) Allow/scope each target on the Safe's proxy.
  //    - Target-level (clearance === 1): allowTarget(roleKey, target, executionOptions).
  //      For MultiSendCallOnly this sets executionOptions = DelegateCall (2) so the
  //      batch entry point is delegate-called.
  //    - Function-level (clearance === 2): scopeFunction(...) per function.
  for (const target of targets) {
    if (target.clearance === 1 /* Target */) {
      calls.push({
        to: rolesModifier,
        value: '0',
        data: ROLES_IFACE.encodeFunctionData('allowTarget', [
          roleKey,
          target.address,
          target.executionOptions,
        ]),
      });
    } else {
      for (const fn of target.functions) {
        const conditions = fn.condition ? flattenCondition(fn.condition) : [];
        calls.push({
          to: rolesModifier,
          value: '0',
          data: ROLES_IFACE.encodeFunctionData('scopeFunction', [
            roleKey,
            target.address,
            fn.selector,
            conditions.map((cond) => ({
              parent: cond.parent,
              paramType: cond.paramType,
              operator: cond.operator,
              compValue: cond.compValue ?? '0x',
            })),
            fn.executionOptions,
          ]),
        });
      }
    }
  }

  // 2b) Register the official MultiSendUnwrapper so the Roles modifier unpacks a
  //     MultiSend batch and checks permissions on each inner call, rather than
  //     treating the batch blob as a black box.
  calls.push({
    to: rolesModifier,
    value: '0',
    data: ROLES_IFACE.encodeFunctionData('setTransactionUnwrapper', [
      MULTI_SEND_CALL_ONLY_ADDRESS,
      MULTI_SEND_SELECTOR,
      MULTI_SEND_UNWRAPPER_ADDRESS,
    ]),
  });

  // 3) Add the executor EOA as a member of the role.
  //    assignRoles(address module, ...) takes the MODULE/MEMBER address — the
  //    executor EOA (which calls execTransactionWithRole directly and is
  //    authenticated as a module). Passing the modifier proxy here would grant
  //    membership to the proxy itself and can trigger module re-registration
  //    conflicts (e.g. Safe GS102).
  calls.push({
    to: rolesModifier,
    value: '0',
    data: ROLES_IFACE.encodeFunctionData('assignRoles', [
      executor,
      [roleKey],
      [true],
    ]),
  });

  return calls;
}

/** Build the permission set for a client Safe. */
export function buildClientPermissions(
  client: ClientSafeConfig,
  operatorSafe: string,
): Parameters<typeof processPermissions>[0] {
  return [
    // delegate-call MultiSendCallOnly (target-level)
    { targetAddress: MULTI_SEND_CALL_ONLY_ADDRESS, delegatecall: true },
    // claim with account == client Safe
    {
      targetAddress: MERKLE_DROP_ADDRESS,
      signature: SELECTORS.claim,
      condition: c.calldataMatches([client.safe], ['address']),
    },
    // transfer with to == operator Safe
    {
      targetAddress: SAFE_TOKEN_ADDRESS,
      signature: SELECTORS.transfer,
      condition: c.calldataMatches([operatorSafe], ['address']),
    },
    // approve with spender == staking contract
    {
      targetAddress: SAFE_TOKEN_ADDRESS,
      signature: SELECTORS.approve,
      condition: c.calldataMatches([STAKING_CONTRACT_ADDRESS], ['address']),
    },
    // stake with validator == client.validator
    {
      targetAddress: STAKING_CONTRACT_ADDRESS,
      signature: SELECTORS.stake,
      condition: c.calldataMatches([client.validator], ['address']),
    },
  ];
}

/** Build the permission set for the operator Safe. */
export function buildOperatorPermissions(
  operator: OperatorSafeConfig,
): Parameters<typeof processPermissions>[0] {
  return [
    { targetAddress: MULTI_SEND_CALL_ONLY_ADDRESS, delegatecall: true },
    {
      targetAddress: MERKLE_DROP_ADDRESS,
      signature: SELECTORS.claim,
      condition: c.calldataMatches([operator.safe], ['address']),
    },
    {
      targetAddress: SAFE_TOKEN_ADDRESS,
      signature: SELECTORS.approve,
      condition: c.calldataMatches([STAKING_CONTRACT_ADDRESS], ['address']),
    },
    {
      targetAddress: STAKING_CONTRACT_ADDRESS,
      signature: SELECTORS.stake,
      condition: c.calldataMatches([operator.validator], ['address']),
    },
  ];
}

/** Wrap raw calls into a Safe Transaction Builder JSON file. */
export function toSafeTxBuilderFile(
  safe: string,
  owner: string,
  name: string,
  description: string,
  calls: Array<{ to: string; value: string; data: string }>,
): SafeTxBuilderFile {
  return {
    version: '1.0.0',
    chainId: '1',
    createdAt: Date.now(),
    meta: {
      name,
      description,
      txBuilderVersion: '1.16.1',
      createdFromSafeAddress: getAddress(safe),
      createdFromOwnerAddress: getAddress(owner),
    },
    transactions: calls.map((call) => ({
      to: getAddress(call.to),
      value: call.value,
      data: call.data,
    })),
  };
}

/** Main generator entry point. */
export async function generateRoleFiles(
  config: ReturnType<typeof loadConfig>,
  outDir: string,
  roleKeyLabel: string,
  enableModuleMode: EnableModuleMode = 'always',
  provider?: JsonRpcProvider,
): Promise<string[]> {
  const roleKey = encodeKey(roleKeyLabel);
  const derivedExecutor = new Wallet(config.executorPrivateKey).address;
  const executor = config.executorAddress ?? derivedExecutor;
  if (config.executorAddress && config.executorAddress.toLowerCase() !== derivedExecutor.toLowerCase()) {
    throw new Error(
      `EXECUTOR_ADDRESS ${config.executorAddress} does not match the address derived from EXECUTOR_PRIVATE_KEY (${derivedExecutor})`,
    );
  }
  const files: string[] = [];

  for (const client of config.clientSafes) {
    const calls = await buildRoleCalls(
      client.safe,
      client.rolesModifier,
      roleKey,
      executor,
      buildClientPermissions(client, config.operatorSafe.safe),
      enableModuleMode,
      provider,
    );
    const file = toSafeTxBuilderFile(
      client.safe,
      executor,
      `Safenet Rewards Role — Client ${client.safe}`,
      `Grants role ${roleKey} on ${client.safe} the permissions to claim Safenet Aegis rewards, route fees to ${config.operatorSafe.safe}, and auto-stake.`,
      calls,
    );
    const path = join(outDir, `roles-client-${client.safe.toLowerCase()}.json`);
    writeFileSync(path, JSON.stringify(file, null, 2));
    files.push(path);
    logger.info(`Wrote ${path} (${calls.length} calls)`);
  }

  const opCalls = await buildRoleCalls(
    config.operatorSafe.safe,
    config.operatorSafe.rolesModifier,
    roleKey,
    executor,
    buildOperatorPermissions(config.operatorSafe),
    enableModuleMode,
    provider,
  );
  const opFile = toSafeTxBuilderFile(
    config.operatorSafe.safe,
    executor,
    `Safenet Rewards Role — Operator ${config.operatorSafe.safe}`,
    `Grants role ${roleKey} on the operator Safe the permissions to claim its own Safenet Aegis rewards and stake 100% of its liquid SAFE balance.`,
    opCalls,
  );
  const opPath = join(outDir, `roles-operator-${config.operatorSafe.safe.toLowerCase()}.json`);
  writeFileSync(opPath, JSON.stringify(opFile, null, 2));
  files.push(opPath);
  logger.info(`Wrote ${opPath} (${opCalls.length} calls)`);

  return files;
}

// CLI entry point.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf('--out');
  const outDir = outFlag >= 0 && args[outFlag + 1] ? resolve(args[outFlag + 1]!) : resolve('roles');
  const keyFlag = args.indexOf('--role-key');
  const roleKeyLabel = keyFlag >= 0 && args[keyFlag + 1] ? args[keyFlag + 1]! : 'safenet-rewards';
  const enableFlag = args.indexOf('--enable-module');
  const enableModuleMode: EnableModuleMode =
    enableFlag >= 0 && args[enableFlag + 1]
      ? (args[enableFlag + 1] as EnableModuleMode)
      : 'auto';

  try {
    mkdirSync(outDir, { recursive: true });
    const config = loadConfig();
    let provider: JsonRpcProvider | undefined;
    if (enableModuleMode === 'auto') {
      provider = new JsonRpcProvider(config.rpcUrl, 1, { staticNetwork: true });
    }
    const files = await generateRoleFiles(config, outDir, roleKeyLabel, enableModuleMode, provider);
    logger.info(`Generated ${files.length} Safe Transaction Builder file(s) in ${outDir}`);
    logger.info('Import each file into https://app.safe.global (Transaction Builder) and execute.');
  } catch (err) {
    logger.error(`setup-roles failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
