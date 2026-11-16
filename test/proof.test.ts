import { describe, expect, it } from 'vitest';
import { shardedProofPath } from '../src/proof.js';

describe('shardedProofPath', () => {
  it('builds the exact sharded layout from the first 4 byte-pairs', () => {
    expect(shardedProofPath('0x03d4969997a6f6cf8b8695c33087aa175a8463d6')).toBe(
      'proofs/03/d4/96/99/0x03d4969997a6f6cf8b8695c33087aa175a8463d6.json',
    );
  });

  it('lowercases the address', () => {
    expect(shardedProofPath('0x03D4969997A6F6CF8B8695C33087AA175A8463D6')).toBe(
      'proofs/03/d4/96/99/0x03d4969997a6f6cf8b8695c33087aa175a8463d6.json',
    );
  });

  it('handles a zero address', () => {
    expect(shardedProofPath('0x0000000000000000000000000000000000000000')).toBe(
      'proofs/00/00/00/00/0x0000000000000000000000000000000000000000.json',
    );
  });
});
