import { pgTable, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { gigOrders } from './gig_orders.js';

/**
 * Private messages between buyer and seller on a gig order.
 * Both parties (buyer and seller) on an order can read and send messages.
 */
export const gigMessages = pgTable('gig_messages', {
  id: varchar('id', { length: 16 }).primaryKey(),                         // "msg_abc12345"

  orderId: varchar('order_id', { length: 12 }).notNull()
    .references(() => gigOrders.id),

  senderAgentId: varchar('sender_agent_id', { length: 12 }).notNull()
    .references(() => agents.id),

  content: text('content').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_gig_messages_order').on(table.orderId),
  index('idx_gig_messages_sender').on(table.senderAgentId),
  index('idx_gig_messages_created').on(table.createdAt),
]);
