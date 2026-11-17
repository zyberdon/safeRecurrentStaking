/**
 * Safenet Aegis bi-weekly rewards automation — two-phase execution.
 *
 * Phase 1: process every client Safe sequentially (fetch proof -> verify root
 *          and Merkle proof -> compute fee/restake split -> simulate via
 *          staticCall -> broadcast -> await tx.wait(1) before the next Safe).
 * Phase 2: process the personal operator Safe STRICTLY LAST — it claims its
 *          own rewards and stakes 100% of its liquid SAFE balance (own rewards
 *          + all collected client fees).
 *
 * Proofs come exclusively from the canonical on-chain ENS distribution
 * `rewards.safenet-gov.eth` (sharded IPFS layout via eth.limo, with an
 * on-chain contenthash -> IPFS gateway fallback). No GitHub mirror is used.
 */

import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import {
  MERKLE_DROP_ADDRESS,
  MULTI_SEND_CALL_ONLY_ADDRESS,
  SAFE_TOKEN_ADDRESS,
  STAKING_CONTRACT_ADDRESS,
  BPS_DENOMINATOR,
  OPERATION_DELEGATE_CALL,
} from './constants.js';
import { MERKLE_DROP_ABI, MULTI_SEND_CALL_ONLY_ABI, ROLES_MODIFIER_ABI, SAFE_TOKEN_ABI, STAKING_ABI } from './abi.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { verifyRewardProof } from './merkle.js';
import {
  describeBatch,
  encodeApprove,
  encodeClaim,
  encodeMultiSendBatch,
  encodeStake,
  encodeTransfer,
  type MultiSendSubCall,
} from './multisend.js';
import { fetchLatestDistribution, fetchRewardProof } from './proof.js';
import type { ClientSafeConfig, OperatorSafeConfig, OperatorOutcome, SafeOutcome, VerifiedProof } from './types.js';

/** Effective fee for a client Safe: global override > per-Safe override > default. */
function effectiveFeeBps(client: ClientSafeConfig, defaultFeeBps: number, overrideFeeBps?: number): number {
  if (overrideFeeBps !== undefined) return overrideFeeBps;
  return client.feeBps ?? defaultFeeBps;
}

/** Split unclaimed rewards into fee (to operator) and restake (in client Safe). */
export function computeSplit(unclaimedDelta: bigint, feeBps: number): { feeAmount: bigint; restakeAmount: bigint } {
  const feeAmount = (unclaimedDelta * BigInt(feeBps)) / BPS_DENOMINATOR;
  return { feeAmount, restakeAmount: unclaimedDelta - feeAmount };
}

/** Fetch + verify a proof for one Safe against on-chain state. Returns null when no proof is published (dormant). */
export async function verifyProofForSafe(
  safe: string,
  provider: JsonRpcProvider,
  proofFetcher: typeof fetchRewardProof,
): Promise<VerifiedProof | null> {
  const drop = new Contract(MERKLE_DROP_ADDRESS, MERKLE_DROP_ABI, provider);
  const [onChainRoot, alreadyClaimed] = await Promise.all([
    drop.merkleRoot!(),
    drop.cumulativeClaimed!(safe),
  ]);
  const proof = await proofFetcher(safe, { provider });
  if (!proof) {
    return null;
  }
  if (proof.merkleRoot.toLowerCase() !== onChainRoot.toLowerCase()) {
    throw new Error(
      `Proof merkleRoot ${proof.merkleRoot} does not match on-chain merkleRoot ${onChainRoot} for ${safe}`,
    );
  }
  const cumulativeAmount = BigInt(proof.cumulativeAmount);
  if (!verifyRewardProof(safe, cumulativeAmount, onChainRoot, proof.proof)) {
    throw new Error(`Local Merkle proof verification FAILED for ${safe}`);
  }
  return {
    safe,
    proof,
    onChainRoot,
    alreadyClaimed,
    unclaimedDelta: cumulativeAmount - alreadyClaimed,
  };
}

/** Build the MultiSendCallOnly sub-calls for a client Safe. */
export function buildClientCalls(
  verified: VerifiedProof,
  client: ClientSafeConfig,
  operatorSafe: string,
  feeBps: number,
): { calls: MultiSendSubCall[]; feeAmount: bigint; restakeAmount: bigint } {
  const { feeAmount, restakeAmount } = computeSplit(verified.unclaimedDelta, feeBps);
  const calls: MultiSendSubCall[] = [
    {
      to: MERKLE_DROP_ADDRESS,
      value: 0n,
      data: encodeClaim(
        client.safe,
        BigInt(verified.proof.cumulativeAmount),
        verified.onChainRoot,
        verified.proof.proof,
      ),
    },
  ];
  if (feeAmount > 0n) {
    calls.push({ to: SAFE_TOKEN_ADDRESS, value: 0n, data: encodeTransfer(operatorSafe, feeAmount) });
  }
  if (restakeAmount > 0n) {
    calls.push({ to: SAFE_TOKEN_ADDRESS, value: 0n, data: encodeApprove(STAKING_CONTRACT_ADDRESS, restakeAmount) });
    calls.push({ to: STAKING_CONTRACT_ADDRESS, value: 0n, data: encodeStake(client.validator, restakeAmount) });
  }
  return { calls, feeAmount, restakeAmount };
}

/** Build the MultiSendCallOnly sub-calls for the operator Safe (stake 100% of liquid balance). */
export function buildOperatorCalls(
  operator: OperatorSafeConfig,
  liquidBalance: bigint,
): { calls: MultiSendSubCall[]; stakedAmount: bigint } {
  const calls: MultiSendSubCall[] = [];
  if (liquidBalance > 0n) {
    calls.push({ to: SAFE_TOKEN_ADDRESS, value: 0n, data: encodeApprove(STAKING_CONTRACT_ADDRESS, liquidBalance) });
    calls.push({ to: STAKING_CONTRACT_ADDRESS, value: 0n, data: encodeStake(operator.validator, liquidBalance) });
  }
  return { calls, stakedAmount: liquidBalance };
}

/** Simulate a roles-modifier execution; returns the revert reason on failure. */
export async function simulateExecution(
  rolesModifier: string,
  roleKey: string,
  encodedMultiSend: string,
  provider: JsonRpcProvider,
): Promise<{ ok: boolean; reason?: string }> {
  const roles = new Contract(rolesModifier, ROLES_MODIFIER_ABI, provider);
  try {
    await roles.execTransactionWithRole!.staticCall(
      MULTI_SEND_CALL_ONLY_ADDRESS,
      0n,
      encodedMultiSend,
      OPERATION_DELEGATE_CALL,
      roleKey,
      true,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Broadcast a roles-modifier execution and wait for confirmation. */
export async function broadcastExecution(
  rolesModifier: string,
  roleKey: string,
  encodedMultiSend: string,
  wallet: Wallet,
): Promise<string> {
  const roles = new Contract(rolesModifier, ROLES_MODIFIER_ABI, wallet);
  const tx = await roles.execTransactionWithRole!(
    MULTI_SEND_CALL_ONLY_ADDRESS,
    0n,
    encodedMultiSend,
    OPERATION_DELEGATE_CALL,
    roleKey,
    true,
  );
  logger.info(`Broadcast tx ${tx.hash} (nonce ${tx.nonce})`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction ${tx.hash} reverted on-chain`);
  }
  return tx.hash;
}

/** Phase 1: process all client Safes sequentially. */
export async function processClientSafes(
  clients: ClientSafeConfig[],
  operatorSafe: string,
  defaultFeeBps: number,
  provider: JsonRpcProvider,
  wallet: Wallet,
  dryRun: boolean,
  overrideFeeBps?: number,
): Promise<SafeOutcome[]> {
  const outcomes: SafeOutcome[] = [];
  for (const client of clients) {
    logger.info(`=== Phase 1: client Safe ${client.safe} ===`);
    try {
      const verified = await verifyProofForSafe(client.safe, provider, fetchRewardProof);
      if (!verified) {
        logger.info(`Dormant: no rewards proof published yet for ${client.safe}`);
        outcomes.push({ status: 'dormant', reason: 'no proof published' });
        continue;
      }
      if (verified.unclaimedDelta <= 0n) {
        logger.info(`Dormant: unclaimedDelta=${verified.unclaimedDelta} for ${client.safe}`);
        outcomes.push({ status: 'dormant', reason: `unclaimedDelta=${verified.unclaimedDelta}` });
        continue;
      }
      const feeBps = effectiveFeeBps(client, defaultFeeBps, overrideFeeBps);
      const { calls, feeAmount, restakeAmount } = buildClientCalls(verified, client, operatorSafe, feeBps);
      logger.info(
        `unclaimed=${verified.unclaimedDelta} feeBps=${feeBps} fee=${feeAmount} restake=${restakeAmount}`,
      );
      logger.debug(`batch: ${describeBatch(calls)}`);

      const encoded = encodeMultiSendBatch(calls);
      const sim = await simulateExecution(client.rolesModifier, client.roleKey, encoded, provider);
      if (!sim.ok) {
        logger.error(`Simulation failed for ${client.safe}: ${sim.reason}`);
        outcomes.push({ status: 'failed', reason: `simulation: ${sim.reason}` });
        continue;
      }
      if (dryRun) {
        logger.info(`[DRY RUN] Would broadcast for ${client.safe} (simulation OK)`);
        outcomes.push({ status: 'skipped', reason: 'dry run' });
        continue;
      }
      const txHash = await broadcastExecution(client.rolesModifier, client.roleKey, encoded, wallet);
      outcomes.push({ status: 'claimed', txHash, feeAmount, restakeAmount });
    } catch (err) {
      logger.error(`Failed to process ${client.safe}: ${(err as Error).message}`);
      outcomes.push({ status: 'failed', reason: (err as Error).message });
    }
  }
  return outcomes;
}

/** Phase 2: process the operator Safe strictly last. */
export async function processOperatorSafe(
  operator: OperatorSafeConfig,
  provider: JsonRpcProvider,
  wallet: Wallet,
  dryRun: boolean,
): Promise<OperatorOutcome> {
  logger.info(`=== Phase 2: operator Safe ${operator.safe} (strictly last) ===`);
  try {
    const drop = new Contract(MERKLE_DROP_ADDRESS, MERKLE_DROP_ABI, provider);
    const token = new Contract(SAFE_TOKEN_ADDRESS, SAFE_TOKEN_ABI, provider);

    // 1) Unclaimed operator rewards on CumulativeMerkleDrop.
    const [onChainRoot, alreadyClaimed, proof] = await Promise.all([
      drop.merkleRoot!(),
      drop.cumulativeClaimed!(operator.safe),
      fetchRewardProof(operator.safe, { provider }).catch(() => null),
    ]);
    let operatorUnclaimedDelta = 0n;
    let claimCall: MultiSendSubCall | null = null;
    if (proof) {
      if (proof.merkleRoot.toLowerCase() !== onChainRoot.toLowerCase()) {
        throw new Error(
          `Operator proof merkleRoot ${proof.merkleRoot} does not match on-chain merkleRoot ${onChainRoot}`,
        );
      }
      const cumulativeAmount = BigInt(proof.cumulativeAmount);
      if (!verifyRewardProof(operator.safe, cumulativeAmount, onChainRoot, proof.proof)) {
        throw new Error(`Local Merkle proof verification FAILED for operator ${operator.safe}`);
      }
      operatorUnclaimedDelta = cumulativeAmount - alreadyClaimed;
      if (operatorUnclaimedDelta > 0n) {
        claimCall = {
          to: MERKLE_DROP_ADDRESS,
          value: 0n,
          data: encodeClaim(operator.safe, cumulativeAmount, onChainRoot, proof.proof),
        };
      }
    }

    // 2) Current liquid SAFE balance (includes all feeAmount transfers swept in Phase 1).
    const currentLiquidSafe = await token.balanceOf!(operator.safe);

    // 3) totalToStake = liquid + unclaimed.
    const totalToStake = currentLiquidSafe + (operatorUnclaimedDelta > 0n ? operatorUnclaimedDelta : 0n);

    // 4) Dormant guard.
    if (totalToStake === 0n) {
      logger.info('Operator Safe dormant: 0 rewards and 0 liquid SAFE to stake');
      return { status: 'dormant', reason: '0 rewards and 0 liquid SAFE to stake' };
    }

    // 5) Build batch: [claim?] + approve(totalToStake) + stake(totalToStake).
    const calls: MultiSendSubCall[] = [];
    if (claimCall) calls.push(claimCall);
    calls.push({ to: SAFE_TOKEN_ADDRESS, value: 0n, data: encodeApprove(STAKING_CONTRACT_ADDRESS, totalToStake) });
    calls.push({ to: STAKING_CONTRACT_ADDRESS, value: 0n, data: encodeStake(operator.validator, totalToStake) });
    logger.info(
      `operatorUnclaimed=${operatorUnclaimedDelta} liquid=${currentLiquidSafe} totalToStake=${totalToStake}`,
    );
    logger.debug(`batch: ${describeBatch(calls)}`);

    // 6) Simulate, broadcast, await tx.wait(1).
    const encoded = encodeMultiSendBatch(calls);
    const sim = await simulateExecution(operator.rolesModifier, operator.roleKey, encoded, provider);
    if (!sim.ok) {
      logger.error(`Simulation failed for operator ${operator.safe}: ${sim.reason}`);
      return { status: 'failed', reason: `simulation: ${sim.reason}` };
    }
    if (dryRun) {
      logger.info(`[DRY RUN] Would broadcast for operator ${operator.safe} (simulation OK)`);
      return { status: 'skipped', reason: 'dry run' };
    }
    const txHash = await broadcastExecution(operator.rolesModifier, operator.roleKey, encoded, wallet);
    return { status: 'claimed', txHash, stakedAmount: totalToStake };
  } catch (err) {
    logger.error(`Failed to process operator ${operator.safe}: ${(err as Error).message}`);
    return { status: 'failed', reason: (err as Error).message };
  }
}

/** Main entry point. */
export async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    `Starting Safenet Aegis rewards automation (dryRun=${config.dryRun}, maxGasPriceGwei=${config.maxGasPriceGwei})`,
  );

  const provider = new JsonRpcProvider(config.rpcUrl, 1, { staticNetwork: true });
  const wallet = new Wallet(config.executorPrivateKey, provider);

  // Gas price guard: abort before sending anything if the network is too expensive.
  const feeData = await provider.getFeeData();
  const maxFeeGwei = feeData.maxFeePerGas ? Number(formatEther(feeData.maxFeePerGas)) * 1e9 : 0;
  if (maxFeeGwei > config.maxGasPriceGwei) {
    throw new Error(
      `Network gas price ${maxFeeGwei.toFixed(2)} gwei exceeds MAX_GAS_PRICE_GWEI ${config.maxGasPriceGwei}; aborting`,
    );
  }
  logger.info(`Network maxFeePerGas: ${maxFeeGwei.toFixed(2)} gwei (limit ${config.maxGasPriceGwei})`);

  // Optional pre-flight: log the published distribution index (non-fatal).
  const latest = await fetchLatestDistribution({ provider });
  if (latest) {
    logger.info(`Distribution index: epoch=${latest.epoch} root=${latest.merkleRoot}`);
  }

  // Phase 1: all client Safes, sequentially.
  const clientOutcomes = await processClientSafes(
    config.clientSafes,
    config.operatorSafe.safe,
    config.defaultFeeBps,
    provider,
    wallet,
    config.dryRun,
    config.overrideFeeBps,
  );

  // Phase 2: operator Safe strictly last.
  const operatorOutcome = await processOperatorSafe(config.operatorSafe, provider, wallet, config.dryRun);

  // Summary.
  logger.info('=== Summary ===');
  for (const [i, o] of clientOutcomes.entries()) {
    logger.info(`Client ${config.clientSafes[i]?.safe}: ${JSON.stringify(o)}`);
  }
  logger.info(`Operator ${config.operatorSafe.safe}: ${JSON.stringify(operatorOutcome)}`);

  // GitHub Actions step summary (Markdown table).
  writeStepSummary(config, clientOutcomes, operatorOutcome);

  const failed = clientOutcomes.some((o) => o.status === 'failed') || operatorOutcome.status === 'failed';
  if (failed) {
    process.exitCode = 1;
  }
}

/** Render the per-Safe Markdown table to $GITHUB_STEP_SUMMARY (GitHub Actions). */
export function writeStepSummary(
  config: ReturnType<typeof loadConfig>,
  clientOutcomes: SafeOutcome[],
  operatorOutcome: OperatorOutcome,
): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const fmt = (v: bigint): string => formatEther(v);
  const rows: string[] = [];
  for (const [i, o] of clientOutcomes.entries()) {
    const safe = config.clientSafes[i]?.safe ?? '?';
    const short = `${safe.slice(0, 6)}…${safe.slice(-4)}`;
    if (o.status === 'claimed') {
      rows.push(`| ${short} | ${fmt(o.feeAmount + o.restakeAmount)} | ${fmt(o.feeAmount)} | ${fmt(o.restakeAmount)} | \`${o.txHash}\` | EXECUTED |`);
    } else if (o.status === 'dormant') {
      rows.push(`| ${short} | 0 | 0 | 0 | — | DORMANT |`);
    } else {
      rows.push(`| ${short} | 0 | 0 | 0 | — | ${o.status.toUpperCase()} |`);
    }
  }
  const opShort = `${config.operatorSafe.safe.slice(0, 6)}…${config.operatorSafe.safe.slice(-4)}`;
  if (operatorOutcome.status === 'claimed') {
    rows.push(`| ${opShort} (operator) | ${fmt(operatorOutcome.stakedAmount)} | — | ${fmt(operatorOutcome.stakedAmount)} | \`${operatorOutcome.txHash}\` | EXECUTED |`);
  } else if (operatorOutcome.status === 'dormant') {
    rows.push(`| ${opShort} (operator) | 0 | — | 0 | — | DORMANT |`);
  } else {
    rows.push(`| ${opShort} (operator) | 0 | — | 0 | — | ${operatorOutcome.status.toUpperCase()} |`);
  }

  const table = [
    '## Safenet Aegis Reward Sweep',
    '',
    '| Safe | Claimed SAFE | Fee to Operator | Restaked SAFE | Tx Hash | Status |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  try {
    appendFileSync(summaryPath, table);
  } catch (err) {
    logger.warn(`Failed to write step summary: ${(err as Error).message}`);
  }
}

// Run when executed directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    logger.error(`Fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
