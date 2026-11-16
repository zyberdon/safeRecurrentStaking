import { describe, expect, it } from 'vitest';
import { computeLeaf, verifyMerkleProof, verifyRewardProof } from '../src/merkle.js';

// Real proof vector fetched from the canonical distribution
// (rewards.safenet-gov.eth, sharded layout) for 0x03d4...3d6.
const VECTOR = {
  address: '0x03d4969997a6f6cf8b8695c33087aa175a8463d6',
  cumulativeAmount: '21119131822660113069200',
  merkleRoot: '0xab638c08ac00981fb708a6d9e0c4667605579aa945629231313ba6c87d1d711e',
  proof: [
    '0xeeb93ced2a28240a770564fd7a2c640f6215720bc80d0459f2d26f9d9a7633bb',
    '0x75dd26d6de8df9a31f48c4706f9b3e2136a06714fedcdaf8e97612288c325df6',
    '0xddbffb8750c1d6e2168aeb149fb84f0ffb8e3d5d3c16041a6eeadc12078df8ee',
    '0xe2b5ae1b1f174aedc4d89fee1089a10f807f2198fbcfe79878459d1f51eb83be',
    '0xc7e1e04cdb69b5502666e556bcdbe73eba602422966be46b1e6a6981d4422f14',
    '0xa81f3e2ddbc4d8e89d99dd1a8df14043a509ed9862a77c81b23da844fc001df8',
    '0x35649974804a012abd5b8d468553b5d32c19c823ce8fc4f30033675245739050',
    '0x1fe9a336ddb1d9b1e5b2c8394de585fa89410b8875bd35acd555b6e4f739ae4f',
    '0x57cb5530a7e06af84b6407fac3978eab8bd9ac33bb9c04d53da4e2c6324aab8c',
    '0x59e6701ae8fef1e042fbd97d65bb1725032bbe5a6739523a8d55ecebe2b066cf',
  ],
};

describe('merkle verification', () => {
  it('verifies the real on-chain proof vector', () => {
    expect(
      verifyRewardProof(VECTOR.address, BigInt(VECTOR.cumulativeAmount), VECTOR.merkleRoot, VECTOR.proof),
    ).toBe(true);
  });

  it('rejects a tampered cumulative amount', () => {
    expect(
      verifyRewardProof(VECTOR.address, BigInt(VECTOR.cumulativeAmount) + 1n, VECTOR.merkleRoot, VECTOR.proof),
    ).toBe(false);
  });

  it('rejects a tampered proof element', () => {
    const bad = [...VECTOR.proof];
    bad[0] = '0x' + '11'.repeat(32);
    expect(verifyRewardProof(VECTOR.address, BigInt(VECTOR.cumulativeAmount), VECTOR.merkleRoot, bad)).toBe(false);
  });

  it('rejects a wrong root', () => {
    expect(
      verifyRewardProof(VECTOR.address, BigInt(VECTOR.cumulativeAmount), '0x' + 'ab'.repeat(32), VECTOR.proof),
    ).toBe(false);
  });

  it('computes the leaf as keccak256(abi.encodePacked(account, amount))', () => {
    const leaf = computeLeaf(VECTOR.address, BigInt(VECTOR.cumulativeAmount));
    expect(leaf).toMatch(/^0x[0-9a-f]{64}$/);
    // The leaf must be the first node of the proof path.
    const firstSibling = VECTOR.proof[0]!;
    const [left, right] =
      leaf.toLowerCase() < firstSibling.toLowerCase()
        ? [leaf, firstSibling]
        : [firstSibling, leaf];
    const { keccak256 } = require('ethers');
    const next = keccak256(`0x${left.slice(2)}${right.slice(2)}`);
    expect(verifyMerkleProof(VECTOR.proof.slice(1), VECTOR.merkleRoot, next)).toBe(true);
  });
});
