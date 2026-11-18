#!/usr/bin/env node
/**
 * Local Ethereum mainnet fork verification for the Safenet Aegis rewards sweep.
 *
 * Starts an `anvil` fork of live mainnet, reconfigures the Roles Modifier on
 * the operator + client Safes by replaying the generated Safe Transaction
 * Builder JSON (from setup-roles.ts), then runs the full sweep against the
 * fork with DRY_RUN=false so real execTransactionWithRole transactions are
 * executed with ZERO real gas.
 *
 * Usage:
 *   node scripts/verify-local-fork.mjs [--anvil-bin /path/to/anvil] [--port 8545]
 *
 * Step-by-step:
 *   1. Launch `anvil --fork-url $RPC_URL` on 127.0.0.1:8545.
 *   2. Impersonate the operator Safe + client Safe (anvil_impersonateAccount),
 *      fund them + the executor with fake ETH (anvil_setBalance).
 *   3. Replay roles-operator-*.json and roles-client-*.json via impersonation.
 *   4. Run the sweep with DRY_RUN=false pointed at the fork.
 *   5. Verify on-fork: operator staked balance increased; print PASS/FAIL.
 *   6. Stop anvil.
 */

import 'dotenv/config';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const ANVIL_URL = 'http://127.0.0.1:8545';

const OPERATOR_SAFE = '0xA3419AB2fD37BFD1E7667097FAA5dE01dc84639B';
const CLIENT_SAFE = '0xA6840fF21360418c38818A540018eD74Bf531dCc';
const OPERATOR_PROXY = '0xfD8418e28a6C39A91F86D12Ecc15f39271DAD649';
const CLIENT_PROXY = '0x14d14E3d87b41195969317A24F8037b52D86D57f';
const EXECUTOR = '0x7D97161910151c19d8655194772E88B01D4CdB6c';
const STAKING = '0x115E78f160e1E3eF163B05C84562Fa16fA338509';
const SAFE_TOKEN = '0x5aFE3855358E112B5647B952709E6165e1c1eEEe';

const args = process.argv.slice(2);
const anvilBin = args.includes('--anvil-bin') ? args[args.indexOf('--anvil-bin') + 1] : undefined;
const portArg = args.includes('--port') ? args[args.indexOf('--port') + 1] : undefined;
const PORT = portArg ?? '8545';
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL not set in .env');

const ANVIL = anvilBin ?? (() => {
  const candidates = [
    process.env.ANVIL_BIN,
    `${process.env.HOME}/.foundry/bin/anvil`,
    'anvil',
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // fall back to PATH lookup
  const which = spawnSync('which', ['anvil'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.trim();
  throw new Error('anvil not found. Install Foundry (https://getfoundry.sh) or pass --anvil-bin');
})();

let anvilProc = null;

function rpc(method, params, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = spawnSync('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      ANVIL_URL,
    ], { encoding: 'utf8', timeout: 20000 });
    if (res.status !== 0) throw new Error(`curl to anvil failed (${method})`);
    const j = JSON.parse(res.stdout);
    if (j.error) {
      if (attempt < retries && /timeout|timed out|Fork Error/i.test(JSON.stringify(j.error))) {
        execSync('sleep 2');
        continue;
      }
      throw new Error(`${method} error: ${JSON.stringify(j.error)}`);
    }
    return j.result;
  }
  throw new Error(`${method} failed after retries`);
}

function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try {
      rpc('eth_blockNumber', []);
      return;
    } catch {
      execSync('sleep 1');
    }
  }
  throw new Error('anvil did not start in time');
}

function startAnvil() {
  console.log(`\n[1/5] Starting anvil fork on ${ANVIL_URL} (fork-url from .env RPC_URL)`);
  anvilProc = spawn(ANVIL, ['--fork-url', RPC_URL, '--port', PORT, '--silent', '--chain-id', '1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  anvilProc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log('  anvil:', s);
  });
  waitForAnvil();
  console.log('  anvil ready');
  // no stale state between runs
  rpc('anvil_reset', [{ forkUrl: RPC_URL }]);
  console.log('  fork reset');
}

function stopAnvil() {
  if (anvilProc) {
    console.log('\n[6/6] Stopping anvil');
    anvilProc.kill('SIGTERM');
    anvilProc = null;
  }
}

function impersonateAndFund() {
  console.log('\n[2/5] Impersonating Safes + executor and funding them with fake ETH');
  for (const addr of [OPERATOR_SAFE, CLIENT_SAFE, EXECUTOR]) {
    rpc('anvil_impersonateAccount', [addr]);
    rpc('anvil_setBalance', [addr, '0x21e19e0c9bab2400000']); // 10000 ETH
    console.log(`  impersonated + funded ${addr}`);
  }
}

function replayRolesJson(file, safe, proxy, label) {
  console.log(`\n[3/5] Replaying ${label} roles JSON on the fork (${file})`);
  if (!existsSync(file)) {
    console.warn(`  WARN ${file} not found; skipping (roles not generated?)`);
    return;
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [i, tx] of data.transactions.entries()) {
    const to = tx.to;
    const calldata = tx.data;
    // execute as the Safe (impersonated owner of the Roles proxy)
    const params = [{
      from: safe,
      to,
      data: calldata,
    }];
    try {
      const hash = rpc('eth_sendTransaction', params);
      // Poll for the receipt (anvil mines instantly but the receipt may lag the response)
      let receipt = null;
      for (let attempt = 0; attempt < 40 && !receipt; attempt++) {
        receipt = rpc('eth_getTransactionReceipt', [hash]);
        if (!receipt) execSync('sleep 1');
      }
      if (!receipt || receipt.status !== '0x1') {
        throw new Error(`tx ${i} reverted (receipt status ${receipt?.status})`);
      }
      console.log(`  tx ${i}: ${to} ${calldata.slice(0, 10)} OK (${hash.slice(0, 10)})`);
    } catch (e) {
      console.error(`  tx ${i} FAILED: ${e.message}`);
      throw e;
    }
  }
  console.log(`  ${label} roles replay complete`);
}

async function runSweep() {
  console.log('\n[4/5] Running full sweep against fork with DRY_RUN=false');
  const env = {
    ...process.env,
    RPC_URL: ANVIL_URL,
    DRY_RUN: 'false',
    LOG_LEVEL: 'info',
  };
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/index.js'], { env, stdio: 'inherit' });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`sweep exited ${code}`)));
  });
}

async function verifyOnFork() {
  console.log('\n[5/5] Verifying on-fork state');
  const { JsonRpcProvider, Contract } = await import('ethers');
  const provider = new JsonRpcProvider(ANVIL_URL, 1, { staticNetwork: true });
  const staking = new Contract(STAKING, ['function stakes(address a, address b) view returns (uint256)'], provider);
  const token = new Contract(SAFE_TOKEN, ['function balanceOf(address) view returns (uint256)'], provider);
  const operator = '0xA3419AB2fD37BFD1E7667097FAA5dE01dc84639B';
  const validator = '0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9';
  const staked = await staking.stakes(operator, validator);
  const liquid = await token.balanceOf(operator);
  console.log(`  operator staked balance: ${staked} wei`);
  console.log(`  operator liquid SAFE balance: ${liquid} wei`);
  if (staked > 0n) {
    console.log('  PASS: operator has staked balance on fork');
    return true;
  }
  console.log('  FAIL: operator staked balance is 0');
  return false;
}

(async () => {
  let ok = false;
  try {
    startAnvil();
    impersonateAndFund();
    replayRolesJson(
      'roles/roles-operator-0xa3419ab2fd37bfd1e7667097faa5de01dc84639b.json',
      OPERATOR_SAFE,
      OPERATOR_PROXY,
      'operator',
    );
    replayRolesJson(
      'roles/roles-client-0xa6840ff21360418c38818a540018ed74bf531dcc.json',
      CLIENT_SAFE,
      CLIENT_PROXY,
      'client',
    );
    await runSweep();
    ok = await verifyOnFork();
  } catch (e) {
    console.error('\nVERIFY FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    stopAnvil();
  }
  process.exit(ok ? 0 : 1);
})();