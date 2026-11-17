/**
 * Protocol & contract constants for the Safenet Aegis rewards automation.
 * All addresses are Ethereum Mainnet (chain id 1).
 */

export const CHAIN_ID = 1n;

export const SAFE_TOKEN_ADDRESS = '0x5aFE3855358E112B5647B952709E6165e1c1eEEe';
export const STAKING_CONTRACT_ADDRESS = '0x115E78f160e1E3eF163B05C84562Fa16fA338509';
export const MERKLE_DROP_ADDRESS = '0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2';
export const MULTI_SEND_CALL_ONLY_ADDRESS = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D';
export const ROLES_MODIFIER_V2_SINGLETON = '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5';

/** MultiSendCallOnly.multiSend(bytes) selector. */
export const MULTI_SEND_SELECTOR = '0x8d80ff0a';

/**
 * Official Zodiac Roles `MultiSendUnwrapper` adapter (mainnet).
 * Registered via setTransactionUnwrapper(MultiSendCallOnly, multiSend.selector, this)
 * so the Roles modifier unpacks a MultiSend batch and checks each inner call
 * against the role instead of treating the batch as a black box.
 */
export const MULTI_SEND_UNWRAPPER_ADDRESS = '0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD';

/** ENS name that points (via contenthash) at the canonical IPFS rewards distribution. */
export const REWARDS_ENS_NAME = 'rewards.safenet-gov.eth';

/** Default gateway for the ENS name (eth.limo). */
export const DEFAULT_PROOF_GATEWAY_URL = 'https://rewards.safenet-gov.eth.limo';

/** Fallback IPFS gateways used after resolving the on-chain contenthash. */
export const DEFAULT_IPFS_GATEWAYS = [
  'https://dweb.link',
  'https://ipfs.io',
  'https://w3s.link',
  'https://4everland.io',
];

/** Basis points denominator. */
export const BPS_DENOMINATOR = 10000n;

/** Default max gas price in GWEI. */
export const DEFAULT_MAX_GAS_PRICE_GWEI = 35;

/** Operation enum for Safe transactions (0 = call, 1 = delegateCall). */
export const OPERATION_CALL = 0;
export const OPERATION_DELEGATE_CALL = 1;

/** MultiSendCallOnly operation byte: 0 = call, 1 = delegateCall. */
export const MULTI_SEND_OP_CALL = 0;
export const MULTI_SEND_OP_DELEGATE_CALL = 1;
