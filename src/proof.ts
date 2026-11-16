/**
 * Safenet Aegis reward proof fetcher.
 *
 * Proofs are fetched from the canonical on-chain ENS distribution
 * `rewards.safenet-gov.eth` (an IPFS site) using the exact sharded layout:
 *
 *   proofs/{b1}/{b2}/{b3}/{b4}/{address}.json
 *
 * where b1..b4 are the first four byte-pairs of the lowercased address after
 * `0x`. There is deliberately NO reliance on the GitHub `safe-fndn/safenet-data`
 * mirror — that repository is updated manually and lags behind on-chain
 * distributions, so it is never used.
 *
 * Resolution order:
 *   1. Primary gateway: https://rewards.safenet-gov.eth.limo (ENS gateway).
 *   2. If that fails (HTTP 403/429/5xx or timeout), resolve the live on-chain
 *      contenthash of `rewards.safenet-gov.eth` via ethers v6 on Ethereum
 *      Mainnet and fetch `/ipfs/{cid}/proofs/...` through configurable fallback
 *      IPFS gateways (dweb.link, ipfs.io).
 *   3. HTTP 404 is handled cleanly: "No rewards proof published yet for {addr}"
 *      (dormant, not a fatal crash).
 */

import { JsonRpcProvider } from 'ethers';
import { DEFAULT_IPFS_GATEWAYS, DEFAULT_PROOF_GATEWAY_URL, REWARDS_ENS_NAME } from './constants.js';
import { logger } from './logger.js';
import type { LatestDistribution, RewardProof } from './types.js';

/** HTTP statuses that trigger the ENS contenthash fallback. */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

export interface ProofFetcherOptions {
  /** Primary ENS gateway base URL (default: eth.limo). */
  gatewayUrl?: string;
  /** Fallback IPFS gateways used after on-chain contenthash resolution. */
  ipfsGateways?: string[];
  /** Provider used for on-chain ENS contenthash resolution. */
  provider: JsonRpcProvider;
  /** Request timeout in ms per attempt. */
  timeoutMs?: number;
}

export class ProofFetchError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-found' | 'network' | 'invalid' | 'unresolved',
  ) {
    super(message);
    this.name = 'ProofFetchError';
  }
}

/** Build the sharded relative proof path for a Safe address. */
export function shardedProofPath(safeAddress: string): string {
  const addr = safeAddress.toLowerCase();
  const b1 = addr.slice(2, 4);
  const b2 = addr.slice(4, 6);
  const b3 = addr.slice(6, 8);
  const b4 = addr.slice(8, 10);
  return `proofs/${b1}/${b2}/${b3}/${b4}/${addr}.json`;
}

/** Normalize a gateway base URL (strip trailing slash). */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'safe-recurrent-staking/1.0' },
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseProofJson(text: string, source: string): RewardProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProofFetchError(`Invalid JSON from ${source}`, 'invalid');
  }
  const p = parsed as Partial<RewardProof>;
  if (
    typeof p.cumulativeAmount !== 'string' ||
    typeof p.merkleRoot !== 'string' ||
    !Array.isArray(p.proof) ||
    !p.proof.every((x) => typeof x === 'string')
  ) {
    throw new ProofFetchError(`Malformed proof payload from ${source}`, 'invalid');
  }
  return {
    cumulativeAmount: p.cumulativeAmount,
    kycAmount: p.kycAmount,
    merkleRoot: p.merkleRoot,
    proof: p.proof,
    sentinelAmount: p.sentinelAmount,
  };
}

/**
 * Fetch `latest.json` from the primary gateway to inspect the published
 * merkleRoot / epoch before querying individual Safe proofs.
 * Returns null when the index is unavailable (non-fatal).
 */
export async function fetchLatestDistribution(
  options: ProofFetcherOptions,
): Promise<LatestDistribution | null> {
  const base = normalizeBase(options.gatewayUrl ?? DEFAULT_PROOF_GATEWAY_URL);
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    const { status, text } = await fetchWithTimeout(`${base}/latest.json`, timeoutMs);
    if (status === 404) return null;
    if (status !== 200) {
      logger.warn(`latest.json fetch failed (HTTP ${status}) from ${base}`);
      return null;
    }
    const parsed = JSON.parse(text) as Partial<LatestDistribution>;
    if (typeof parsed.merkleRoot !== 'string') return null;
    return {
      epoch: parsed.epoch ?? 0,
      merkleRoot: parsed.merkleRoot,
      rewardsUntil: parsed.rewardsUntil,
      tokenTotal: parsed.tokenTotal,
      unpaidAmount: parsed.unpaidAmount,
      sentinelTokenTotal: parsed.sentinelTokenTotal,
    };
  } catch (err) {
    logger.warn(`latest.json fetch failed from ${base}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve the live on-chain contenthash of `rewards.safenet-gov.eth` using
 * ethers v6 (handles ENSIP-10 wildcard resolution). Returns the IPFS CID
 * (base32, without the `ipfs://` prefix) or null when unset/unresolvable.
 */
export async function resolveEnsContentHash(
  provider: JsonRpcProvider,
): Promise<string | null> {
  try {
    const resolver = await provider.getResolver(REWARDS_ENS_NAME);
    if (!resolver) {
      logger.warn(`No ENS resolver found for ${REWARDS_ENS_NAME}`);
      return null;
    }
    const contentHash = await resolver.getContentHash();
    if (!contentHash) {
      logger.warn(`No contenthash set for ${REWARDS_ENS_NAME}`);
      return null;
    }
    if (contentHash.startsWith('ipfs://')) {
      return contentHash.slice('ipfs://'.length);
    }
    if (contentHash.startsWith('ipns://')) {
      logger.warn(`contenthash for ${REWARDS_ENS_NAME} is ipns:// (unsupported): ${contentHash}`);
      return null;
    }
    logger.warn(`contenthash for ${REWARDS_ENS_NAME} is not IPFS: ${contentHash}`);
    return null;
  } catch (err) {
    logger.warn(`Failed to resolve contenthash for ${REWARDS_ENS_NAME}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch the reward proof for a Safe.
 *
 * @returns the parsed proof, or null when the account has no published proof (404).
 * @throws ProofFetchError when all sources fail or the payload is malformed.
 */
export async function fetchRewardProof(
  safeAddress: string,
  options: ProofFetcherOptions,
): Promise<RewardProof | null> {
  const addr = safeAddress.toLowerCase();
  const path = shardedProofPath(addr);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const primaryBase = normalizeBase(options.gatewayUrl ?? DEFAULT_PROOF_GATEWAY_URL);
  const primaryUrl = `${primaryBase}/${path}`;

  // 1) Primary ENS gateway (eth.limo).
  try {
    const { status, text } = await fetchWithTimeout(primaryUrl, timeoutMs);
    if (status === 404) {
      logger.info(`No rewards proof published yet for ${addr} (HTTP 404 from ${primaryBase})`);
      return null;
    }
    if (status === 200) {
      const proof = parseProofJson(text, primaryUrl);
      logger.debug(`Fetched proof for ${addr} from ${primaryUrl}`);
      return proof;
    }
    logger.warn(`Primary gateway returned HTTP ${status} for ${addr}; trying ENS contenthash fallback`);
  } catch (err) {
    logger.warn(`Primary gateway failed for ${addr}: ${(err as Error).message}; trying ENS contenthash fallback`);
  }

  // 2) On-chain ENS contenthash -> IPFS gateways.
  const cid = await resolveEnsContentHash(options.provider);
  if (!cid) {
    throw new ProofFetchError(
      `Could not resolve contenthash for ${REWARDS_ENS_NAME}; no fallback source available`,
      'unresolved',
    );
  }

  const gateways = options.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS;
  let lastError: Error | null = null;
  for (const gateway of gateways) {
    const url = `${normalizeBase(gateway)}/ipfs/${cid}/${path}`;
    try {
      const { status, text } = await fetchWithTimeout(url, timeoutMs);
      if (status === 404) {
        logger.info(`No rewards proof published yet for ${addr} (HTTP 404 from ${gateway})`);
        return null;
      }
      if (status === 200) {
        const proof = parseProofJson(text, url);
        logger.debug(`Fetched proof for ${addr} from ${url}`);
        return proof;
      }
      lastError = new Error(`HTTP ${status} from ${gateway}`);
      logger.warn(`IPFS gateway ${gateway} returned HTTP ${status} for ${addr}`);
    } catch (err) {
      lastError = err as Error;
      logger.warn(`IPFS gateway ${gateway} failed for ${addr}: ${(err as Error).message}`);
    }
  }

  throw new ProofFetchError(
    `All proof sources failed for ${addr}: ${lastError?.message ?? 'unknown error'}`,
    'network',
  );
}

export { RETRYABLE_STATUS };
