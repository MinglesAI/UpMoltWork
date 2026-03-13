import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { db } from '../db/pool.js';
import { x402Payments } from '../db/schema/index.js';

const PLATFORM_PRIVATE_KEY = process.env.PLATFORM_EVM_PRIVATE_KEY as `0x${string}`;
const PLATFORM_EVM_ADDRESS = process.env.PLATFORM_EVM_ADDRESS as `0x${string}`;
const BASE_NETWORK = process.env.BASE_NETWORK ?? 'eip155:84532';

// USDC contract addresses by network
const USDC_CONTRACTS: Record<string, `0x${string}`> = {
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base Mainnet
};

// RPC endpoints by network
const RPC_URLS: Record<string, string> = {
  'eip155:84532': 'https://sepolia.base.org',
  'eip155:8453': 'https://mainnet.base.org',
};

const CHAIN_BY_NETWORK: Record<string, typeof baseSepolia | typeof base> = {
  'eip155:84532': baseSepolia,
  'eip155:8453': base,
};

// ERC-20 transfer ABI
const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const USDC_DECIMALS = 6;
const PLATFORM_FEE_RATE = 0.05; // 5%

function getChain() {
  return CHAIN_BY_NETWORK[BASE_NETWORK] ?? baseSepolia;
}

function getUsdcContract(): `0x${string}` {
  const addr = USDC_CONTRACTS[BASE_NETWORK];
  if (!addr) throw new Error(`No USDC contract for network ${BASE_NETWORK}`);
  return addr;
}

function getWalletClient() {
  const account = privateKeyToAccount(PLATFORM_PRIVATE_KEY);
  return createWalletClient({
    account,
    chain: getChain(),
    transport: http(RPC_URLS[BASE_NETWORK] ?? 'https://sepolia.base.org'),
  });
}

function getPublicClient() {
  return createPublicClient({
    chain: getChain(),
    transport: http(RPC_URLS[BASE_NETWORK] ?? 'https://sepolia.base.org'),
  });
}

/**
 * Transfer USDC from platform wallet to a recipient.
 * Applies 5% platform fee (platform keeps fee, sends remainder).
 * Records payment in x402_payments.
 */
export async function transferUsdc(opts: {
  to: `0x${string}`;
  amountUsdc: number; // gross amount before fee
  taskId?: string;
}): Promise<string> {
  const { to, amountUsdc, taskId } = opts;
  const netAmount = amountUsdc * (1 - PLATFORM_FEE_RATE);
  const amountWei = parseUnits(netAmount.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const walletClient = getWalletClient();
  const usdcContract = getUsdcContract();

  const txHash = await walletClient.writeContract({
    address: usdcContract,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amountWei],
  });

  // Record in DB
  await db.insert(x402Payments).values({
    taskId: taskId ?? null,
    payerAddress: PLATFORM_EVM_ADDRESS,
    recipientAddress: to,
    amountUsdc: netAmount.toFixed(USDC_DECIMALS),
    txHash,
    network: BASE_NETWORK,
    paymentType: 'payout',
  });

  console.log(`[usdc-transfer] Paid ${netAmount} USDC (net, after 5% fee) to ${to}. tx: ${txHash}`);
  return txHash;
}

/**
 * Refund USDC from platform wallet back to payer.
 * Sends full amount (no fee on refunds).
 */
export async function refundUsdc(opts: {
  to: `0x${string}`;
  amountUsdc: number;
  taskId?: string;
}): Promise<string> {
  const { to, amountUsdc, taskId } = opts;
  const amountWei = parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const walletClient = getWalletClient();
  const usdcContract = getUsdcContract();

  const txHash = await walletClient.writeContract({
    address: usdcContract,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amountWei],
  });

  // Record in DB
  await db.insert(x402Payments).values({
    taskId: taskId ?? null,
    payerAddress: PLATFORM_EVM_ADDRESS,
    recipientAddress: to,
    amountUsdc: amountUsdc.toFixed(USDC_DECIMALS),
    txHash,
    network: BASE_NETWORK,
    paymentType: 'refund',
  });

  console.log(`[usdc-transfer] Refunded ${amountUsdc} USDC to ${to}. tx: ${txHash}`);
  return txHash;
}

/**
 * Get platform USDC balance.
 */
export async function getPlatformUsdcBalance(): Promise<string> {
  const publicClient = getPublicClient();
  const usdcContract = getUsdcContract();
  const balance = await publicClient.readContract({
    address: usdcContract,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [PLATFORM_EVM_ADDRESS],
  });
  return formatUnits(balance as bigint, USDC_DECIMALS);
}

export { USDC_CONTRACTS, BASE_NETWORK as CURRENT_NETWORK };
