/**
 * Minimal ABIs for the contracts this automation interacts with.
 * Signatures verified against verified source on Sourcify/Etherscan (mainnet).
 */

export const SAFE_TOKEN_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

export const STAKING_ABI = [
  'function stake(address validator, uint256 amount) external',
  'function stakes(address staker, address validator) external view returns (uint256)',
  'function totalStakerStakes(address staker) external view returns (uint256)',
] as const;

export const MERKLE_DROP_ABI = [
  'function merkleRoot() external view returns (bytes32)',
  'function cumulativeClaimed(address account) external view returns (uint256)',
  'function claim(address account, uint256 cumulativeAmount, bytes32 expectedMerkleRoot, bytes32[] calldata merkleProof) external',
] as const;

export const MULTI_SEND_CALL_ONLY_ABI = [
  'function multiSend(bytes transactions) external payable',
] as const;

export const ROLES_MODIFIER_ABI = [
  'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) external returns (bool)',
] as const;
