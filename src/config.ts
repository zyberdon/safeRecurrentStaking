/**
 * Environment & configuration loading and validation.
 *
 * Validates:
 *  - RPC_URL (http/https)
 *  - EXECUTOR_PRIVATE_KEY (32-byte hex)
 *  - DEFAULT_FEE_BPS (0..10000)
 *  - CLIENT_SAFES_JSON (array of client configs, per-Safe feeBps optional)
 *  - OPERATOR_SAFE_JSON (single operator config)
 *  - MAX_GAS_PRICE_GWEI (default 35)
 *  - DRY_RUN (boolean)
 */

import { isAddress, isHexString } from 'ethers';
import { DEFAULT_MAX_GAS_PRICE_GWEI } from './constants.js';
import type { ClientSafeConfig, OperatorSafeConfig } from './types.js';

export interface AppConfig {
  rpcUrl: string;
  executorPrivateKey: string;
  /** Optional explicit executor address; when set, setup-roles verifies it matches the private key. */
  executorAddress?: string;
  defaultFeeBps: number;
  /** Optional global override (workflow_dispatch manual testing); beats per-Safe feeBps. */
  overrideFeeBps?: number;
  clientSafes: ClientSafeConfig[];
  operatorSafe: OperatorSafeConfig;
  maxGasPriceGwei: number;
  dryRun: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function assertAddress(value: string, label: string): void {
  if (!isAddress(value)) {
    throw new ConfigError(`${label} is not a valid address: ${value}`);
  }
}

function assertBytes32(value: string, label: string): void {
  if (!isHexString(value, 32)) {
    throw new ConfigError(`${label} must be a 32-byte hex string (bytes32): ${value}`);
  }
}

function parseFeeBps(value: number | undefined, label: string): number {
  if (value === undefined) return value as never;
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new ConfigError(`${label} must be an integer in [0, 10000], got ${value}`);
  }
  return value;
}

function parseClientSafes(raw: string): ClientSafeConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('CLIENT_SAFES_JSON is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError('CLIENT_SAFES_JSON must be a non-empty JSON array');
  }
  return parsed.map((entry, i) => {
    const e = entry as Partial<ClientSafeConfig>;
    const label = `CLIENT_SAFES_JSON[${i}]`;
    if (typeof e.safe !== 'string') throw new ConfigError(`${label}.safe is required`);
    if (typeof e.rolesModifier !== 'string') throw new ConfigError(`${label}.rolesModifier is required`);
    if (typeof e.roleKey !== 'string') throw new ConfigError(`${label}.roleKey is required`);
    if (typeof e.validator !== 'string') throw new ConfigError(`${label}.validator is required`);
    assertAddress(e.safe, `${label}.safe`);
    assertAddress(e.rolesModifier, `${label}.rolesModifier`);
    assertBytes32(e.roleKey, `${label}.roleKey`);
    assertAddress(e.validator, `${label}.validator`);
    const feeBps = parseFeeBps(e.feeBps, `${label}.feeBps`);
    return {
      safe: e.safe,
      rolesModifier: e.rolesModifier,
      roleKey: e.roleKey,
      validator: e.validator,
      ...(feeBps !== undefined ? { feeBps } : {}),
    };
  });
}

function parseOperatorSafe(raw: string): OperatorSafeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('OPERATOR_SAFE_JSON is not valid JSON');
  }
  const e = parsed as Partial<OperatorSafeConfig>;
  if (typeof e.safe !== 'string') throw new ConfigError('OPERATOR_SAFE_JSON.safe is required');
  if (typeof e.rolesModifier !== 'string') throw new ConfigError('OPERATOR_SAFE_JSON.rolesModifier is required');
  if (typeof e.roleKey !== 'string') throw new ConfigError('OPERATOR_SAFE_JSON.roleKey is required');
  if (typeof e.validator !== 'string') throw new ConfigError('OPERATOR_SAFE_JSON.validator is required');
  assertAddress(e.safe, 'OPERATOR_SAFE_JSON.safe');
  assertAddress(e.rolesModifier, 'OPERATOR_SAFE_JSON.rolesModifier');
  assertBytes32(e.roleKey, 'OPERATOR_SAFE_JSON.roleKey');
  assertAddress(e.validator, 'OPERATOR_SAFE_JSON.validator');
  return { safe: e.safe, rolesModifier: e.rolesModifier, roleKey: e.roleKey, validator: e.validator };
}

function parseMaxGasPrice(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_GAS_PRICE_GWEI;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`MAX_GAS_PRICE_GWEI must be a positive number, got ${raw}`);
  }
  return v;
}

function parseDryRun(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new ConfigError(`DRY_RUN must be a boolean, got ${raw}`);
}

function parseOverrideFeeBps(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0 || v > 10000) {
    throw new ConfigError(`OVERRIDE_FEE_BPS must be an integer in [0, 10000], got ${raw}`);
  }
  return v;
}

/** Load and validate configuration from process.env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcUrl = requireEnv('RPC_URL');
  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new ConfigError(`RPC_URL must be an http(s) URL, got ${rpcUrl}`);
  }

  const executorPrivateKey = requireEnv('EXECUTOR_PRIVATE_KEY');
  if (!isHexString(executorPrivateKey, 32)) {
    throw new ConfigError('EXECUTOR_PRIVATE_KEY must be a 32-byte hex string');
  }

  const executorAddressRaw = env.EXECUTOR_ADDRESS;
  if (executorAddressRaw !== undefined && executorAddressRaw.trim() !== '') {
    if (!isAddress(executorAddressRaw)) {
      throw new ConfigError(`EXECUTOR_ADDRESS is not a valid address: ${executorAddressRaw}`);
    }
  }

  const defaultFeeBpsRaw = env.DEFAULT_FEE_BPS ?? '2500';
  const defaultFeeBps = Number(defaultFeeBpsRaw);
  if (!Number.isInteger(defaultFeeBps) || defaultFeeBps < 0 || defaultFeeBps > 10000) {
    throw new ConfigError(`DEFAULT_FEE_BPS must be an integer in [0, 10000], got ${defaultFeeBpsRaw}`);
  }

  return {
    rpcUrl,
    executorPrivateKey,
    executorAddress:
      executorAddressRaw !== undefined && executorAddressRaw.trim() !== ''
        ? executorAddressRaw
        : undefined,
    defaultFeeBps,
    overrideFeeBps: parseOverrideFeeBps(env.OVERRIDE_FEE_BPS),
    clientSafes: parseClientSafes(requireEnv('CLIENT_SAFES_JSON')),
    operatorSafe: parseOperatorSafe(requireEnv('OPERATOR_SAFE_JSON')),
    maxGasPriceGwei: parseMaxGasPrice(env.MAX_GAS_PRICE_GWEI),
    dryRun: parseDryRun(env.DRY_RUN),
  };
}
