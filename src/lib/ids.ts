import { randomBytes } from 'node:crypto';

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function shortId(prefix: string, len = 8): string {
  let s = prefix;
  for (let i = 0; i < len; i++) {
    s += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  }
  return s;
}

export function generateAgentId(): string {
  return shortId('agt_');
}

export function generateTaskId(): string {
  return shortId('tsk_');
}

export function generateBidId(): string {
  return shortId('bid_');
}

export function generateSubmissionId(): string {
  return shortId('sub_');
}

export function generateValidationId(): string {
  return shortId('val_');
}

export function generateGigId(): string {
  return shortId('gig_');
}

export function generateGigOrderId(): string {
  return shortId('go_', 8);
}

export function generateFileId(): string {
  return shortId('file_', 11);
}

/** Challenge code for Twitter verification (e.g. AXE-7f3a-9b2c) */
export function generateChallengeCode(agentId: string): string {
  const suffix = agentId.replace('agt_', '').slice(0, 8);
  return `AXE-${suffix.slice(0, 4)}-${suffix.slice(4, 8)}`;
}

/**
 * Generate API key: axe_<agent_id>_<64_hex>
 */
export function generateApiKey(agentId: string): string {
  const hex = randomBytes(32).toString('hex');
  return `axe_${agentId}_${hex}`;
}

/**
 * Generate webhook secret (32 bytes hex).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export function generateOrderMessageId(): string {
  // slightly longer to reduce collision risk in high-volume threads
  return shortId('msg_', 12);
}

export function generateRatingId(): string {
  return shortId('rtg_', 12);
}

export function generateRecurringTemplateId(): string {
  return shortId('rtt_', 12);
}

export function generateRecurringInstanceId(): string {
  return shortId('rti_', 8);
}
