/**
 * MultiSendCallOnly (v1.3.0) transaction encoding.
 *
 * Each sub-transaction is packed as:
 *   [1 byte operation][20 bytes to][32 bytes value][32 bytes dataLength][data]
 *
 * The whole batch is passed to `multiSend(bytes transactions)`.
 * MultiSendCallOnly only supports operation 0 (call) — it reverts on
 * delegateCall, which is exactly the safety property we want for
 * claim/transfer/approve/stake.
 */

import { Interface, concat, getAddress, hexlify, toBeHex, zeroPadValue } from 'ethers';
import { MULTI_SEND_OP_CALL } from './constants.js';

export interface MultiSendSubCall {
  to: string;
  value: bigint;
  data: string;
}

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const STAKING_IFACE = new Interface(['function stake(address validator, uint256 amount)']);

const MULTI_SEND_IFACE = new Interface(['function multiSend(bytes transactions)']);

const MERKLE_DROP_IFACE = new Interface([
  'function claim(address account, uint256 cumulativeAmount, bytes32 expectedMerkleRoot, bytes32[] merkleProof)',
]);

/** Encode a single sub-transaction in MultiSendCallOnly wire format. */
export function encodeMultiSendSubCall(call: MultiSendSubCall): string {
  const to = getAddress(call.to);
  const value = zeroPadValue(toBeHex(call.value), 32);
  const data = hexlify(call.data);
  const dataLength = zeroPadValue(toBeHex(BigInt((data.length - 2) / 2)), 32);
  const op = hexlify(Uint8Array.from([MULTI_SEND_OP_CALL]));
  return concat([op, to, value, dataLength, data]);
}

/** Encode a full batch of sub-calls as the complete `multiSend(bytes)` calldata. */
export function encodeMultiSendBatch(calls: MultiSendSubCall[]): string {
  const packed = concat(calls.map(encodeMultiSendSubCall));
  return MULTI_SEND_IFACE.encodeFunctionData('multiSend', [packed]);
}

/** Human-readable summary of a batch (for dry-run logging). */
export function describeBatch(calls: MultiSendSubCall[]): string {
  return calls
    .map((c) => {
      const sig = c.data.length >= 10 ? c.data.slice(0, 10) : c.data;
      return `${c.to} ${sig} value=${c.value.toString()}`;
    })
    .join(' | ');
}

/** Encode a `transfer(address,uint256)` call. */
export function encodeTransfer(to: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData('transfer', [getAddress(to), amount]);
}

/** Encode an `approve(address,uint256)` call. */
export function encodeApprove(spender: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData('approve', [getAddress(spender), amount]);
}

/** Encode a `stake(address validator, uint256 amount)` call. */
export function encodeStake(validator: string, amount: bigint): string {
  return STAKING_IFACE.encodeFunctionData('stake', [getAddress(validator), amount]);
}

/** Encode a `claim(...)` call on the CumulativeMerkleDrop. */
export function encodeClaim(
  account: string,
  cumulativeAmount: bigint,
  expectedMerkleRoot: string,
  merkleProof: string[],
): string {
  return MERKLE_DROP_IFACE.encodeFunctionData('claim', [
    getAddress(account),
    cumulativeAmount,
    expectedMerkleRoot,
    merkleProof,
  ]);
}
