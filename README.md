# Safe Recurrent Staking

Automated bi-weekly claiming of **Safenet Aegis SAFE staking rewards** across multiple client Safe accounts, with an adjustable percentage fee routed to a personal operator Safe and automatic restaking of the remainder — running on GitHub Actions.

## How it works

Two-phase execution, every run:

1. **Phase 1 — Client Safes (sequential):** for each client Safe, fetch its reward proof from the canonical on-chain ENS distribution, verify the Merkle root and proof locally, compute the fee/restake split, simulate via `staticCall`, broadcast, and `await tx.wait(1)` before moving to the next Safe.
2. **Phase 2 — Operator Safe (strictly last):** after every client Safe has confirmed on-chain, it claims its own unclaimed rewards and stakes **100% of its total liquid SAFE** (`liquid balance + unclaimed rewards` = own rewards + all collected client fees).

```
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 1 (per client Safe, sequential)                               │
│                                                                     │
│  proof (ENS/IPFS) ──► verify root + Merkle proof ──► compute split  │
│        │                                                           │
│        ▼                                                           │
│  MultiSendCallOnly batch:                                          │
│    claim(drop, cumulativeAmount, root, proof)                      │
│    transfer(operatorSafe, feeAmount)        [if feeAmount > 0]     │
│    approve(staking, restakeAmount)          [if restakeAmount > 0] │
│    stake(validator, restakeAmount)          [if restakeAmount > 0] │
│        │                                                           │
│        ▼                                                           │
│  staticCall simulate ──► broadcast ──► await tx.wait(1) ──► next   │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 2 (operator Safe, strictly last)                              │
│                                                                     │
│  unclaimed = cumulativeAmount - cumulativeClaimed(operatorSafe)     │
│  liquid    = balanceOf(operatorSafe)   (incl. Phase 1 fee sweeps)   │
│  totalToStake = liquid + unclaimed                                 │
│  if totalToStake == 0: "Operator Safe dormant" and exit            │
│  batch: [claim?] + approve(staking, totalToStake)                  │
│                + stake(validator, totalToStake)  (100%)             │
└─────────────────────────────────────────────────────────────────────┘
```

## Proof source: canonical on-chain ENS distribution (no GitHub mirror)

Reward proofs are fetched **exclusively** from the canonical `rewards.safenet-gov.eth` ENS distribution. The GitHub `safe-fndn/safenet-data` mirror is **never used** — it is updated manually and lags behind on-chain distributions.

### Sharded IPFS layout

Proofs live in a sharded directory structure. For a Safe address, the first four byte-pairs after `0x` form the path:

```
addr  = 0x03d4969997a6f6cf8b8695c33087aa175a8463d6
b1=03 b2=d4 b3=96 b4=99
path  = proofs/03/d4/96/99/0x03d4969997a6f6cf8b8695c33087aa175a8463d6.json
```

### Resolution order

1. **Primary gateway:** `https://rewards.safenet-gov.eth.limo/proofs/{b1}/{b2}/{b3}/{b4}/{addr}.json`
2. **On-chain ENS contenthash fallback:** if the primary gateway fails (HTTP 403/429/5xx or timeout), the code resolves the **live on-chain contenthash** of `rewards.safenet-gov.eth` via `ethers` v6 (`provider.getResolver(...).getContentHash()`), then fetches `/ipfs/{cid}/proofs/{b1}/{b2}/{b3}/{b4}/{addr}.json` through configurable IPFS gateways (`dweb.link`, `ipfs.io`, `w3s.link`, `4everland.io`).
3. **HTTP 404** is handled cleanly: `"No rewards proof published yet for {addr}"` → the Safe is treated as dormant, not a crash.

`latest.json` is also fetched from the primary gateway first to inspect the published `merkleRoot` / `epoch` before querying individual proofs.

### Strict on-chain verification before execution

Before any transaction is built:

1. `merkleRoot()` is read from `CumulativeMerkleDrop` (`0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2`).
2. The fetched proof's `merkleRoot` must **exactly match** the on-chain root.
3. The Merkle proof is **verified locally** (`keccak256(abi.encodePacked(account, cumulativeAmount))` leaf, sorted-pair hashing) — so a reverting transaction is never broadcast, even if the IPFS/ENS distribution is slightly ahead of or behind the on-chain root update.

## Contracts (Ethereum Mainnet, chain id 1)

| Contract | Address |
|---|---|
| SAFE Token | `0x5aFE3855358E112B5647B952709E6165e1c1eEEe` |
| Safenet Aegis Staking | `0x115E78f160e1E3eF163B05C84562Fa16fA338509` |
| CumulativeMerkleDrop (rewards) | `0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2` |
| Safe MultiSendCallOnly v1.3.0 | `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` |
| Zodiac Roles Modifier v2 | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` |

## One-time setup: Zodiac Roles permissions

Before the automation can run, the executor EOA needs a role on every Safe. Generate Safe Transaction Builder JSON files with:

```bash
npm run build
node dist/setup-roles.js --out roles --role-key safenet-rewards
```

The `--enable-module` flag controls the `enableModule` step (default `auto`):
- `auto` — queries `Safe.isModuleEnabled()` on-chain (via `RPC_URL`) and omits `enableModule` when the Roles Modifier proxy is already enabled on that Safe; includes it otherwise. Prevents redundant re-enable calls for Safes that already have the module.
- `always` — always emit `enableModule` (idempotent on Safe; re-enabling an already-enabled module is a no-op).
- `skip` — never emit `enableModule` (use when the module is already enabled on every Safe).

This reads `CLIENT_SAFES_JSON` / `OPERATOR_SAFE_JSON` / `EXECUTOR_PRIVATE_KEY` from the environment and writes one JSON file per Safe:

- **Client Safes** — grants `roleKey` permission to delegate-call `MultiSendCallOnly` and call:
  - `CumulativeMerkleDrop.claim` (with `account == client.safe`)
  - `SAFE.transfer` (with `to == OPERATOR_SAFE.safe`)
  - `SAFE.approve` (with `spender == STAKING_CONTRACT`)
  - `Staking.stake` (with `validator == client.validator`)
- **Operator Safe** — grants `roleKey` permission for `CumulativeMerkleDrop.claim` (`account == OPERATOR_SAFE.safe`), `SAFE.approve` (`spender == STAKING_CONTRACT`), and `Staking.stake`.

Staking permissions are included in the initial setup **even when `DEFAULT_FEE_BPS=10000`** so changing the fee percentage later requires zero on-chain re-signing.

Import each generated JSON into the [Safe Transaction Builder](https://app.safe.global) and execute with the Safe owners. The executor EOA is added as a role member (`assignRoles`) in the same batch.

> **Important — proxy vs singleton:** the `rolesModifier` value in `CLIENT_SAFES_JSON` / `OPERATOR_SAFE_JSON` must be the **deployed Roles Modifier proxy address** for that specific Safe (the module instance enabled on the Safe), **not** the master-copy singleton `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5`. All scoping calls (`scopeTarget`, `scopeFunction`, `assignRoles`) target that proxy; calling them on the singleton reverts with `OwnableUnauthorizedAccount` because the singleton's owner is the deployer, not the Safe. `setup-roles.ts` fails fast if you pass the singleton.

> **assignRoles member:** the first argument of `assignRoles` is the **executor EOA** (the module/member that calls `execTransactionWithRole`), not the modifier proxy. Passing the proxy would grant membership to the proxy itself and can trigger module re-registration conflicts (e.g. Safe `GS102`).

## Setup

### 1. Prerequisites

- Node.js **20+** (the workflow uses Node 20).
- A dedicated **gas-only EOA** (`EXECUTOR_PRIVATE_KEY`). It must be a member of the Roles Modifier v2 on **every** Safe (client and operator) with a role that permits `execTransactionWithRole → MultiSendCallOnly → {claim, transfer, approve, stake}`. It should hold only a small ETH balance for gas — it never receives SAFE.
- An Ethereum Mainnet RPC URL.

### 2. Configure

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `RPC_URL` | Ethereum Mainnet RPC URL |
| `EXECUTOR_PRIVATE_KEY` | Gas-only EOA private key (32-byte hex) |
| `DEFAULT_FEE_BPS` | Default fee in basis points `0..10000` (`2500` = 25% fee / 75% restaked) |
| `CLIENT_SAFES_JSON` | JSON array of client Safe configs (see below) |
| `OPERATOR_SAFE_JSON` | JSON object for the personal operator Safe |
| `MAX_GAS_PRICE_GWEI` | Max gas price in gwei; run aborts above this (default `35`) |
| `DRY_RUN` | `true` = simulate only, broadcast nothing (default `true`) |
| `PROOF_GATEWAY_URL` | Primary ENS gateway (default `https://rewards.safenet-gov.eth.limo`) |
| `IPFS_GATEWAYS` | JSON array of fallback IPFS gateways |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

```jsonc
// CLIENT_SAFES_JSON — feeBps is optional, overrides DEFAULT_FEE_BPS per Safe
[
  {
    "safe": "0x...",
    "rolesModifier": "0x...",
    "roleKey": "0x...",
    "validator": "0x...",
    "feeBps": 2500
  }
]

// OPERATOR_SAFE_JSON
{
  "safe": "0x...",
  "rolesModifier": "0x...",
  "roleKey": "0x...",
  "validator": "0x..."
}
```

### 3. Local run

```bash
npm ci
npm run build
DRY_RUN=true node dist/index.js   # simulate only
DRY_RUN=false node dist/index.js  # broadcast
```

### 4. GitHub Actions

Add the following **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `RPC_URL` | Mainnet RPC URL |
| `EXECUTOR_PRIVATE_KEY` | Gas-only EOA private key |
| `DEFAULT_FEE_BPS` | e.g. `2500` |
| `CLIENT_SAFES_JSON` | JSON array (single line) |
| `OPERATOR_SAFE_JSON` | JSON object (single line) |
| `MAX_GAS_PRICE_GWEI` | e.g. `35` |
| `DRY_RUN` | `true` or `false` |
| `OVERRIDE_FEE_BPS` | optional; global fee override for manual testing |

The workflow (`.github/workflows/weekly-sweep.yml`):

- Runs **every hour on every Tuesday UTC** (`cron: '0 * * * 2'`). The run is idempotent — when all Safes are dormant it exits in ~3 seconds with 0 gas.
- Supports `workflow_dispatch` with optional `dry_run` and `override_fee_bps` inputs for manual testing.
- Uses `concurrency` group `safenet-reward-compounder` with `cancel-in-progress: false` (no overlapping runs).
- Installs, type-checks, tests, builds, runs the automation with secrets injected.
- Writes a **Markdown table to `$GITHUB_STEP_SUMMARY`** showing per-Safe: Claimed SAFE, Fee Sent to Operator, Restaked SAFE, Tx Hash, and Status (`EXECUTED` vs `DORMANT`).
- Runs a **parity guard** (`src/parity-check.ts`) that verifies `cumulativeClaimed(safe) == proof.cumulativeAmount` for every client Safe and that the operator Safe's liquid SAFE balance is `0` — failing the run if on-chain state doesn't match expectations.

## Safety properties

- **Sequential confirmation:** each client Safe's transaction is confirmed (`tx.wait(1)`) before the next is processed; the operator Safe runs strictly last.
- **Local Merkle verification:** a claim is never broadcast unless the proof verifies against the on-chain root.
- **Simulation before broadcast:** every batch is `staticCall`-simulated through the Roles Modifier; failures are logged and skipped, never broadcast.
- **Gas price guard:** the run aborts before sending anything if `maxFeePerGas` exceeds `MAX_GAS_PRICE_GWEI`.
- **MultiSendCallOnly:** only operation 0 (call) is supported by the contract — no delegateCall is possible.
- **Dry-run default:** `DRY_RUN` defaults to `true`; flip it only after a successful dry run.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (merkle, multisend, split, proof path)
npm run build       # tsc -> dist/
```

## License

MIT
