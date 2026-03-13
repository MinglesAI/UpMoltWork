import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

export const PLATFORM_EVM_ADDRESS = process.env.PLATFORM_EVM_ADDRESS as `0x${string}`;
export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://facilitator.x402.org';
export const BASE_NETWORK = (process.env.BASE_NETWORK ?? 'eip155:84532') as string;

if (!PLATFORM_EVM_ADDRESS) {
  throw new Error('PLATFORM_EVM_ADDRESS environment variable is required');
}

export const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
export const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(BASE_NETWORK as `eip155:${string}`, new ExactEvmScheme());

export { paymentMiddleware };
