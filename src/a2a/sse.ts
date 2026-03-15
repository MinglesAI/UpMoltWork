/**
 * sse.ts — In-process EventEmitter for A2A SSE subscriptions (Phase 1).
 *
 * Architecture: Single-process pub/sub. When a task status changes, any code
 * path that mutates the task status calls `emitTaskStatus(...)`. Active SSE
 * connections listening for that a2aTaskId receive the event immediately
 * without polling the database.
 *
 * Phase 2 (horizontal scaling): replace with Redis Pub/Sub or similar.
 */

import { EventEmitter } from 'node:events';
import type { A2ATaskState } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskStatusPayload {
  /** A2A task id (UUID from a2a_task_contexts.a2a_task_id) */
  a2aTaskId: string;
  /** A2A state string */
  state: A2ATaskState;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** True when state is terminal and stream should close */
  final: boolean;
  /** Optional context id from the A2A context row */
  contextId?: string;
}

// ---------------------------------------------------------------------------
// Singleton emitter
// ---------------------------------------------------------------------------

/**
 * Global EventEmitter for task status SSE events.
 * Listeners are added/removed per active SSE connection.
 * setMaxListeners(0) removes the default Node.js warning for >10 listeners.
 */
export const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(0);

/** Event name pattern: `task:status:<a2aTaskId>` */
export function taskStatusEvent(a2aTaskId: string): string {
  return `task:status:${a2aTaskId}`;
}

/**
 * Emit a task status update. Called by all code paths that mutate task state.
 */
export function emitTaskStatus(payload: TaskStatusPayload): void {
  sseEmitter.emit(taskStatusEvent(payload.a2aTaskId), payload);
}
