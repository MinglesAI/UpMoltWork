import { pgTable, varchar, text, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { gigs } from './gigs.js';

/**
 * Gig Order Lifecycle States
 *
 * pending            → Order placed, payment escrowed, waiting for seller to accept
 * accepted           → Seller accepted, work in progress
 * delivered          → Seller submitted deliverables, waiting for buyer review
 * revision_requested → Buyer requested changes (seller must re-deliver)
 * completed          → Buyer confirmed delivery; payment released to seller
 * cancelled          → Cancelled before completion; buyer refunded
 * disputed           → Buyer raised a dispute; requires admin resolution
 *
 * Valid transitions:
 *   pending            → accepted           (seller accepts)
 *   pending            → cancelled          (buyer cancels before acceptance)
 *   accepted           → delivered          (seller delivers work)
 *   accepted           → cancelled          (seller declines / timeout)
 *   delivered          → completed          (buyer approves)
 *   delivered          → revision_requested (buyer requests changes)
 *   delivered          → disputed           (buyer disputes)
 *   revision_requested → delivered          (seller re-delivers)
 *   disputed           → completed          (admin resolves for seller)
 *   disputed           → cancelled          (admin resolves for buyer)
 */
export const GIG_ORDER_STATES = [
  'pending',
  'accepted',
  'delivered',
  'revision_requested',
  'completed',
  'cancelled',
  'disputed',
] as const;

export type GigOrderState = (typeof GIG_ORDER_STATES)[number];

/** Allowed state transitions: from → set of valid next states */
export const GIG_ORDER_TRANSITIONS: Record<GigOrderState, GigOrderState[]> = {
  pending:            ['accepted', 'cancelled'],
  accepted:           ['delivered', 'cancelled'],
  delivered:          ['completed', 'revision_requested', 'disputed'],
  revision_requested: ['delivered'],
  completed:          [],
  cancelled:          [],
  disputed:           ['completed', 'cancelled'],
};

export const gigOrders = pgTable('gig_orders', {
  id: varchar('id', { length: 12 }).primaryKey(),                          // "go_abc12345"

  gigId: varchar('gig_id', { length: 12 }).notNull()
    .references(() => gigs.id),

  /** Agent who placed the order (buyer) */
  buyerAgentId: varchar('buyer_agent_id', { length: 12 }).notNull()
    .references(() => agents.id),

  /** Agent who provides the service (seller = gig creator) */
  sellerAgentId: varchar('seller_agent_id', { length: 12 }).notNull()
    .references(() => agents.id),

  /** Agreed price at time of order (snapshot from gig, may differ if gig price changed) */
  pricePoints: decimal('price_points', { precision: 12, scale: 2 }),
  priceUsdc:   decimal('price_usdc',   { precision: 12, scale: 6 }),

  /** Payment currency used for this order */
  paymentMode: varchar('payment_mode', { length: 10 }).notNull().default('points'), // 'points' | 'usdc'

  status: varchar('status', { length: 20 }).notNull().default('pending'),

  /** Requirements / custom instructions from buyer */
  requirements: text('requirements'),

  /** Seller's delivery: URL or inline content */
  deliveryUrl:     text('delivery_url'),
  deliveryContent: text('delivery_content'),
  deliveryNotes:   text('delivery_notes'),

  /** Buyer feedback / reason for revision request or dispute */
  buyerFeedback: text('buyer_feedback'),

  /** Admin dispute resolution notes */
  disputeResolution: text('dispute_resolution'),

  /** Number of revision cycles used */
  revisionCount: varchar('revision_count', { length: 5 }).default('0'),

  /** Timestamps for lifecycle milestones */
  acceptedAt:  timestamp('accepted_at',  { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_gig_orders_gig').on(table.gigId),
  index('idx_gig_orders_buyer').on(table.buyerAgentId),
  index('idx_gig_orders_seller').on(table.sellerAgentId),
  index('idx_gig_orders_status').on(table.status),
  index('idx_gig_orders_created').on(table.createdAt),
]);
