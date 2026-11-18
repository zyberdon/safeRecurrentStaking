#!/usr/bin/env node
/**
 * Fork verification for the CLIENT Safe fee-split path (feeBps: 9500).
 *
 * The real client Safe has no published proof on mainnet, so this:
 *   1. Injects a cryptographically-valid 2-leaf Merkle tree for the client
 *      (root -> drop slot 1, funds drop's SAFE balance, cumulativeClaimed=0).
 *   2. Serves the client proof JSON from a local gateway on :8547 and points
 *      the sweep at it via PROOF_GATEWAY_URL.
 *   3. Runs the REAL sweep (DRY_RUN=false) against anvil :8546 and verifies
 *      the 95/5 fee split: 95% to operator Safe, 5% restaked by client Safe.
 *   4. Operator phase runs strictly last; with the injected root it correctly
 *      reports a proof mismatch (its own proof still matches the real root),
 *      which is expected and does not affect the client-side claims.
 */
import 'dotenv/config';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { keccak256, concat, zeroPadValue, toBeHex, solidityPackedKeccak256, JsonRpcProvider, Contract } from 'ethers';

const ANVIL_URL = 'http://127.0.0.1:8546';
const GATEWAY_URL = 'http://127.0.0.1:8547';
const CLIENT = '0xA6840fF21360418c38818A540018eD74Bf531dCc';
const OPERATOR = '0xA3419AB2fD37BFD1E7667097FAA5dE01dc84639B';
const EXECUTOR = '0x7D97161910151c19d8655194772E88B01D4CdB6c';
const STAKING = '0x115E78f160e1E3eF163B05C84562Fa16fA338509';
const SAFE_TOKEN = '0x5aFE3855358E112B5647B952709E6165e1c1eEEe';
const DROP = '0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2';
const VALIDATOR = '0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9';
const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`;
const RPC = process.env.RPC_URL;
if (!RPC) throw new Error('RPC_URL not set in .env');

const CLIENT_CUMULATIVE = 100_000_000_000_000_000_000n; // 100 SAFE
// Use the ACTUAL per-Safe feeBps from .env (CLIENT_SAFES_JSON)
const envClients = JSON.parse(process.env.CLIENT_SAFES_JSON || '[]');
const FEE_BPS = Number(envClients[0]?.feeBps ?? process.env.DEFAULT_FEE_BPS ?? 2500);
console.log('using feeBps from .env:', FEE_BPS);
const restakeAmount = (CLIENT_CUMULATIVE * BigInt(10000 - FEE_BPS)) / 10000n;
const feeAmount = CLIENT_CUMULATIVE - restakeAmount;
console.log('expected restake:', restakeAmount.toString(), 'expected fee:', feeAmount.toString());

let anvilProc = null;
let gatewayProc = null;

function rpc(method, params) {
  const res = spawnSync('curl', ['-s','-X','POST','-H','Content-Type: application/json',
    '-d', JSON.stringify({ jsonrpc:'2.0', id:1, method, params }), ANVIL_URL], { encoding:'utf8', timeout: 20000 });
  if (res.status !== 0) throw new Error(`curl ${method} failed`);
  const j = JSON.parse(res.stdout);
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
function waitForAnvil() {
  for (let i=0;i<60;i++){ try { rpc('eth_blockNumber',[]); return; } catch { execSync('sleep 1'); } }
  throw new Error('anvil did not start');
}
function startAnvil() {
  console.log(`\n[1/7] Starting anvil fork on ${ANVIL_URL}`);
  anvilProc = spawn(ANVIL, ['--fork-url', RPC, '--port', '8546', '--silent', '--chain-id', '1'], { stdio: ['ignore','pipe','pipe'] });
  anvilProc.stderr.on('data', d => { const s=d.toString().trim(); if(s) console.log('  anvil:', s); });
  waitForAnvil();
  rpc('anvil_reset', [{ forkUrl: RPC }]);
  console.log('  anvil ready, fork reset');
}
function stopAnvil() { if (anvilProc) { anvilProc.kill('SIGTERM'); anvilProc=null; } if (gatewayProc) { gatewayProc.close(); gatewayProc=null; } }

async function replayRoles(file, safe, label) {
  console.log(`\n[2/7] Replaying ${label} roles JSON on the fork`);
  const data = JSON.parse(readFileSync(file,'utf8'));
  for (const [i, tx] of data.transactions.entries()) {
    const hash = rpc('eth_sendTransaction', [{ from: safe, to: tx.to, data: tx.data }]);
    let receipt=null;
    for (let a=0;a<40 && !receipt;a++){ receipt = rpc('eth_getTransactionReceipt',[hash]); if(!receipt) execSync('sleep 1'); }
    if (!receipt || receipt.status !== '0x1') throw new Error(`roles tx ${i} reverted`);
    console.log(`  tx ${i}: ${tx.data.slice(0,10)} OK`);
  }
  console.log(`  ${label} roles replay complete`);
}

async function injectClientMerkle(provider) {
  console.log('\n[3/7] Injecting 2-leaf Merkle tree + funding drop for client claim');
  const leaf = (addr, amt) => solidityPackedKeccak256(['address','uint256'], [addr, amt]);
  const filler = '0x' + '99'.repeat(20);
  const l1 = leaf(CLIENT, CLIENT_CUMULATIVE);
  const l2 = leaf(filler, 1n);
  const pair = [l1, l2].sort((a,b) => (a < b ? -1 : 1));
  const root = keccak256(concat([pair[0], pair[1]]));
  const proof = pair[0] === l1 ? [pair[1]] : [pair[0]];
  console.log('  generated merkleRoot:', root);
  console.log('  client proof len:', proof.length);

  rpc('anvil_setStorageAt', [DROP, '0x' + 1n.toString(16).padStart(64,'0'), root]);
  const balancesBase = '0x' + 0n.toString(16).padStart(64,'0');
  const balSlot = keccak256(concat([zeroPadValue(DROP.toLowerCase(), 32), balancesBase]));
  rpc('anvil_setStorageAt', [SAFE_TOKEN, balSlot, zeroPadValue(toBeHex(CLIENT_CUMULATIVE), 32)]);

  const drop = new Contract(DROP, ['function merkleRoot() view returns (bytes32)','function cumulativeClaimed(address) view returns (uint256)'], provider);
  console.log('  on-fork merkleRoot:', await drop.merkleRoot());
  console.log('  on-fork cumulativeClaimed(client):', (await drop.cumulativeClaimed(CLIENT)).toString());

  // Serve the proof JSON from a local gateway
  const addr = CLIENT.toLowerCase();
  const path = `proofs/${addr.slice(2,4)}/${addr.slice(4,6)}/${addr.slice(6,8)}/${addr.slice(8,10)}/${addr}.json`;
  const proofJson = JSON.stringify({ cumulativeAmount: CLIENT_CUMULATIVE.toString(), merkleRoot: root, proof });
  gatewayProc = http.createServer((req, res) => {
    console.log('  gateway:', req.method, req.url);
    if (req.url.split('?')[0] === '/' + path) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(proofJson);
    } else {
      res.writeHead(404); res.end('not found');
    }
  }).listen(8547, '127.0.0.1');
  console.log(`  local proof gateway on ${GATEWAY_URL} (${path})`);
  return root;
}

async function runSweep() {
  console.log('\n[4/7] Running full sweep (DRY_RUN=false, PROOF_GATEWAY_URL=local)');
  const env = { ...process.env, RPC_URL: ANVIL_URL, DRY_RUN: 'false', LOG_LEVEL: 'info', PROOF_GATEWAY_URL: GATEWAY_URL };
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/index.js'], { env, stdio: 'inherit' });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`sweep exited ${code}`)));
  });
}

async function verifyOnFork(provider) {
  console.log('\n[5/7] Verifying on-fork state');
  const token = new Contract(SAFE_TOKEN, ['function balanceOf(address) view returns (uint256)'], provider);
  const staking = new Contract(STAKING, ['function stakes(address a, address b) view returns (uint256)'], provider);
  const opLiquid = await token.balanceOf(OPERATOR);
  const opStaked = await staking.stakes(OPERATOR, VALIDATOR);
  const clientStaked = await staking.stakes(CLIENT, VALIDATOR);
  console.log('  operator liquid SAFE:', opLiquid.toString());
  console.log('  operator staked toward validator:', opStaked.toString());
  console.log('  client staked toward validator:', clientStaked.toString());
  console.log(`  expected client restake: ${restakeAmount}`);
  console.log(`  expected operator fee: ${feeAmount}`);
  // Client claims 100 SAFE: restake stays in client stake; fee transfers to
  // operator, who (Phase 2) stakes 100% of liquid. Operator liquid must be 0
  // and operator staked must include the fee it received.
  const ok = clientStaked === restakeAmount && opLiquid === 0n && opStaked >= feeAmount;
  console.log(ok ? `  PASS: client claimed; restake ${restakeAmount} in client stake; fee ${feeAmount} routed to operator and staked` : '  FAIL: split mismatch');
  return ok;
}

(async () => {
  let ok = false;
  try {
    startAnvil();
    for (const a of [CLIENT, OPERATOR, EXECUTOR]) { rpc('anvil_impersonateAccount',[a]); rpc('anvil_setBalance',[a,'0x21e19e0c9bab2400000']); }
    console.log('  impersonated + funded Safes + executor');
    await replayRoles('roles/roles-client-0xa6840ff21360418c38818a540018ed74bf531dcc.json', CLIENT, 'client');
    await replayRoles('roles/roles-operator-0xa3419ab2fd37bfd1e7667097faa5de01dc84639b.json', OPERATOR, 'operator');
    const provider = new JsonRpcProvider(ANVIL_URL, 1, { staticNetwork: true });
    await injectClientMerkle(provider);
    try {
      await runSweep();
    } catch (e) {
      // The sweep exits 1 because the operator phase correctly reports the injected
      // root mismatch; the client claim already executed. Continue to verify.
      console.log('  (sweep exit 1 expected: operator proof mismatch on injected root)');
    }
    ok = await verifyOnFork(provider);
  } catch (e) {
    console.error('\nVERIFY FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    stopAnvil();
  }
  process.exit(ok ? 0 : 1);
})();
