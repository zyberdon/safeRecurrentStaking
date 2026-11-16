/**
 * Shared types for the Safenet Aegis rewards automation.
 */

/** A Safe account configured to have its rewards claimed and auto-staked. */
export interface ClientSafeConfig {
  /** Safe account address that receives the rewards. */
  safe: string;
  /** Zodiac Roles Modifier v2 singleton address for this Safe. */
  rolesModifier: string;
  /** bytes32 role key that permits the claim/stake flow on this Safe. */
  roleKey: string;
  /** Validator address to stake under (registered with the staking contract). */
  validator: string;
  /** Optional per-Safe fee override in basis points (0..10000). */
  feeBps?: number;
}

/** The personal operator Safe. Runs strictly last. */
export interface OperatorSafeConfig {
  safe: string;
  rolesModifier: string;
  roleKey: string;
  validator: string;
}

/** Raw proof JSON published by the Safenet Aegis distribution. */
export interface RewardProof {
  /** Cumulative claimable amount (wei) for the account. */
  cumulativeAmount: string;
  /** KYC-gated amount (wei), unused by this automation. */
  kycAmount?: string;
  /** Merkle root this proof was generated against. */
  merkleRoot: string;
  /** Merkle proof path (hex strings). */
  proof: string[];
  /** Sentinel amount (wei), informational. */
  sentinelAmount?: string;
}

/** `latest.json` index published alongside the proofs. */
export interface LatestDistribution {
  epoch: number;
  merkleRoot: string;
  rewardsUntil?: string;
  tokenTotal?: string;
  unpaidAmount?: string;
  sentinelTokenTotal?: string;
}

/** Result of fetching + verifying a proof for one Safe. */
export interface VerifiedProof {
  safe: string;
  proof: RewardProof;
  /** On-chain merkleRoot() at fetch time. */
  onChainRoot: string;
  /** cumulativeClaimed(safe) at fetch time. */
  alreadyClaimed: bigint;
  /** proof.cumulativeAmount - alreadyClaimed. */
  unclaimedDelta: bigint;
}

/** Outcome of processing one Safe. */
export type SafeOutcome =
  | { status: 'claimed'; txHash: string; feeAmount: bigint; restakeAmount: bigint }
  | { status: 'dormant'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/** Outcome of processing the operator Safe. */
export type OperatorOutcome =
  | { status: 'claimed'; txHash: string; stakedAmount: bigint }
  | { status: 'dormant'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };
