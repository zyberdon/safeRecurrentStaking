import { describe, expect, it } from 'vitest';
import { encodeMultiSendBatch, encodeMultiSendSubCall } from '../src/multisend.js';

describe('multisend encoding', () => {
  it('encodes a sub-call with the MultiSendCallOnly wire format', () => {
    const encoded = encodeMultiSendSubCall({
      to: '0x5aFE3855358E112B5647B952709E6165e1c1eEEe',
      value: 0n,
      data: '0xdeadbeef',
    });
    // 1 byte op + 20 bytes to + 32 bytes value + 32 bytes length + 4 bytes data
    expect(encoded).toMatch(/^0x/);
    expect((encoded.length - 2) / 2).toBe(1 + 20 + 32 + 32 + 4);
    // operation byte must be 0 (call only)
    expect(encoded.slice(2, 4)).toBe('00');
    // to address
    expect(encoded.slice(4, 44)).toBe('5afe3855358e112b5647b952709e6165e1c1eeee');
    // value = 0
    expect(encoded.slice(44, 108)).toBe('00'.repeat(32));
    // data length = 4
    expect(encoded.slice(108, 172)).toBe('00'.repeat(31) + '04');
    // data
    expect(encoded.slice(172)).toBe('deadbeef');
  });

  it('encodes a batch by concatenating sub-calls', () => {
    const a = encodeMultiSendSubCall({ to: '0x' + '11'.repeat(20), value: 1n, data: '0xaa' });
    const b = encodeMultiSendSubCall({ to: '0x' + '22'.repeat(20), value: 2n, data: '0xbb' });
    expect(encodeMultiSendBatch([
      { to: '0x' + '11'.repeat(20), value: 1n, data: '0xaa' },
      { to: '0x' + '22'.repeat(20), value: 2n, data: '0xbb' },
    ])).toBe(a + b.slice(2));
  });
});
