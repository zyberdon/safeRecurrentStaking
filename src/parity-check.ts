/**
 * Post-run parity guard.
 *
 * Verifies on-chain state after the automation run:
 *  - For each client Safe: cumulativeClaimed(safe) == proof.cumulativeAmount
 *    (i.e. the full published reward was claimed).
 *  - For the operator Safe: liquid SAFE balance is zero (100% staked).
 *
 * Exits non-zero when parity is violated, which fails the workflow and
 * surfaces the discrepancy in the Actions run.
 */

import 'dotenv/config';
import { Contract, JsonRpcProvider } from 'ethers';
import { MERKLE_DROP_ABI, SAFE_TOKEN_ABI } from './abi.js';
import { MERKLE_DROP_ADDRESS, SAFE_TOKEN_ADDRESS } from './constants.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { fetchRewardProof } from './proof.js';

export async function parityCheck(): Promise<void> {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, 1, { staticNetwork: true });
  const drop = new Contract(MERKLE_DROP_ADDRESS, MERKLE_DROP_ABI, provider);
  const token = new Contract(SAFE_TOKEN_ADDRESS, SAFE_TOKEN_ABI, provider);

  let failed = false;

  for (const client of config.clientSafes) {
    const proof = await fetchRewardProof(client.safe, { provider });
    if (!proof) {
      logger.info(`Parity: no proof published for ${client.safe}; nothing to verify`);
      continue;
    }
    const claimed = await drop.cumulativeClaimed!(client.safe);
    const expected = BigInt(proof.cumulativeAmount);
    if (claimed !== expected) {
      logger.error(
        `Parity VIOLATION for ${client.safe}: cumulativeClaimed=${claimed} != proof cumulativeAmount=${expected}`,
      );
      failed = true;
    } else {
      logger.info(`Parity OK for ${client.safe}: cumulativeClaimed=${claimed}`);
    }
  }

  const operatorBalance = await token.balanceOf!(config.operatorSafe.safe);
  if (operatorBalance > 0n) {
    logger.error(
      `Parity VIOLATION for operator ${config.operatorSafe.safe}: liquid SAFE balance=${operatorBalance} (expected 0)`,
    );
    failed = true;
  } else {
    logger.info(`Parity OK for operator ${config.operatorSafe.safe}: liquid balance=0`);
  }

  if (failed) {
    throw new Error('Parity check failed — on-chain state does not match expectations');
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  parityCheck().catch((err) => {
    logger.error(`Parity check failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
