/**
 * Local Merkle proof verification for the Safenet Aegis CumulativeMerkleDrop.
 *
 * The leaf format is taken from the verified contract source
 * (0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2, CumulativeMerkleDrop.sol):
 *
 *   leaf = keccak256(abi.encodePacked(account, cumulativeAmount))
 *
 * and verification uses sorted-pair hashing:
 *
 *   node = keccak256(min(leaf, sibling) || max(leaf, sibling))
 *
 * We verify locally before building any transaction so we never broadcast a
 * claim that would revert (e.g. if the IPFS/ENS distribution is slightly ahead
 * of or behind the on-chain merkleRoot() update).
 */

import { getAddress, keccak256, solidityPackedKeccak256 } from 'ethers';

/** Compute the CumulativeMerkleDrop leaf for (account, cumulativeAmount). */
export function computeLeaf(account: string, cumulativeAmount: bigint): string {
  return solidityPackedKeccak256(['address', 'uint256'], [getAddress(account), cumulativeAmount]);
}

/**
 * Verify a Merkle proof against a root using sorted-pair hashing.
 * @param proof hex-encoded sibling hashes (leaf -> root order)
 * @param root expected root
 * @param leaf the leaf hash
 */
export function verifyMerkleProof(proof: string[], root: string, leaf: string): boolean {
  let node = leaf;
  for (const siblingHex of proof) {
    const sibling = siblingHex.toLowerCase();
    const [left, right] =
      node.toLowerCase() < sibling ? [node, sibling] : [sibling, node];
    node = keccak256(`0x${left.slice(2)}${right.slice(2)}`);
  }
  return node.toLowerCase() === root.toLowerCase();
}

/** Convenience: verify a full proof for (account, cumulativeAmount) against a root. */
export function verifyRewardProof(
  account: string,
  cumulativeAmount: bigint,
  root: string,
  proof: string[],
): boolean {
  const leaf = computeLeaf(account, cumulativeAmount);
  return verifyMerkleProof(proof, root, leaf);
}
