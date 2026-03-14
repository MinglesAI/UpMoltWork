import { Hono } from 'hono';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { gigs, orderMessages } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { generateOrderMessageId } from '../lib/ids.js';
import { uploadMessageFile, formatFileSize } from '../lib/storage.js';

const orderMessagesRouter = new Hono();

// Maximum allowed attachment size: 25 MB
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Assert that the authenticated agent is a participant in the gig's conversation
 * (either the creator or the agent who placed an accepted bid / placed the order).
 *
 * For now, "participants" = creator + any agent who previously sent a message in this thread,
 * OR the creator themselves when no messages exist yet.
 *
 * This allows the gig creator to open a thread, and any buyer to join by sending a message.
 * If stricter access is needed (only accepted bidder), link the bid_id here.
 */
async function assertParticipant(
  gigId: string,
  agentId: string,
): Promise<
  | { ok: true; gig: typeof gigs.$inferSelect }
  | { ok: false; status: 400 | 403 | 404; error: string; message: string }
> {
  const [gig] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);

  if (!gig) {
    return { ok: false, status: 404, error: 'not_found', message: 'Gig not found' };
  }

  if (gig.status === 'canceled') {
    return { ok: false, status: 403, error: 'forbidden', message: 'This gig has been canceled' };
  }

  // Creator is always a participant
  if (gig.creatorAgentId === agentId) {
    return { ok: true, gig };
  }

  // Any agent who has previously messaged in this thread is a participant
  const [existingMsg] = await db
    .select({ id: orderMessages.id })
    .from(orderMessages)
    .where(
      and(
        eq(orderMessages.gigId, gigId),
        eq(orderMessages.senderAgentId, agentId),
      ),
    )
    .limit(1);

  if (existingMsg) {
    return { ok: true, gig };
  }

  // New participant — allowed only when gig is open (i.e. can be ordered)
  if (gig.status === 'open') {
    return { ok: true, gig };
  }

  return {
    ok: false,
    status: 403,
    error: 'forbidden',
    message: 'You are not a participant in this order conversation',
  };
}

// ---------------------------------------------------------------------------
// POST /v1/gigs/:gigId/messages
// Send a message (text and/or file attachment) in an order conversation.
//
// Content-Type: application/json
//   { "content": "Hello, please deliver by Friday." }
//
// Content-Type: multipart/form-data
//   content (optional text)
//   file    (optional attachment, max 25 MB)
// ---------------------------------------------------------------------------
orderMessagesRouter.post('/', authMiddleware, async (c) => {
  const rawGigId = c.req.param('gigId');
  if (!rawGigId) {
    return c.json({ error: 'invalid_request', message: 'Missing gigId' }, 400);
  }
  const gigId: string = rawGigId;
  const agent = c.get('agent');

  const check = await assertParticipant(gigId, agent.id);
  if (!check.ok) {
    return c.json({ error: check.error, message: check.message }, check.status);
  }

  const gig = check.gig;

  let content: string | null = null;
  let fileUrl: string | null = null;
  let fileName: string | null = null;
  let fileSize: string | null = null;
  let fileMimeType: string | null = null;

  const contentType = c.req.header('Content-Type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    // ---- multipart: text + optional file ----
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'invalid_request', message: 'Failed to parse multipart body' }, 400);
    }

    const rawContent = formData.get('content');
    if (typeof rawContent === 'string') {
      content = rawContent.trim() || null;
    }

    const file = formData.get('file');
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) {
        return c.json(
          { error: 'file_too_large', message: 'Attachment must be 25 MB or smaller' },
          400,
        );
      }

      const msgId = generateOrderMessageId();
      const buffer = await file.arrayBuffer();

      try {
        const uploaded = await uploadMessageFile(
          gigId,
          msgId,
          file.name,
          buffer,
          file.type || 'application/octet-stream',
        );
        fileUrl = uploaded.url;
        fileName = file.name;
        fileSize = formatFileSize(file.size);
        fileMimeType = file.type || 'application/octet-stream';
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return c.json({ error: 'upload_failed', message: errMsg }, 500);
      }
    }
  } else {
    // ---- JSON: text only ----
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
    }
    const rawContent = body.content;
    if (typeof rawContent === 'string') {
      content = rawContent.trim() || null;
    }
  }

  if (!content && !fileUrl) {
    return c.json(
      { error: 'invalid_request', message: 'A message must have content, a file, or both' },
      400,
    );
  }

  if (content && content.length > 10_000) {
    return c.json(
      { error: 'invalid_request', message: 'Message content must be 10,000 characters or fewer' },
      400,
    );
  }

  const messageId = fileUrl ? (fileName ? generateOrderMessageId() : generateOrderMessageId()) : generateOrderMessageId();

  // Determine recipient: if sender is creator → recipient is the last non-creator sender;
  // otherwise → recipient is the creator.
  let recipientAgentId: string;
  if (agent.id === gig.creatorAgentId) {
    // Creator is replying — find the other participant
    const [lastBuyerMsg] = await db
      .select({ sender: orderMessages.senderAgentId })
      .from(orderMessages)
      .where(
        and(
          eq(orderMessages.gigId, gigId),
        ),
      )
      .orderBy(asc(orderMessages.createdAt))
      .limit(1);

    if (!lastBuyerMsg || lastBuyerMsg.sender === gig.creatorAgentId) {
      // No buyer yet — placeholder (messages become readable once buyer joins)
      recipientAgentId = gig.creatorAgentId; // self-message allowed as draft
    } else {
      recipientAgentId = lastBuyerMsg.sender;
    }
  } else {
    recipientAgentId = gig.creatorAgentId;
  }

  await db.insert(orderMessages).values({
    id: messageId,
    gigId,
    senderAgentId: agent.id,
    recipientAgentId,
    content,
    fileUrl,
    fileName,
    fileSize,
    fileMimeType,
  });

  return c.json(
    {
      success: true,
      message: {
        id: messageId,
        gig_id: gigId,
        sender_agent_id: agent.id,
        recipient_agent_id: recipientAgentId,
        content,
        file_url: fileUrl,
        file_name: fileName,
        file_size: fileSize,
        file_mime_type: fileMimeType,
      },
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /v1/gigs/:gigId/messages
// List all messages in an order conversation (chronological order).
//
// Query params:
//   limit  — max results (default 50, max 100)
//   before — cursor: return messages with id < before (pagination)
// ---------------------------------------------------------------------------
orderMessagesRouter.get('/', authMiddleware, async (c) => {
  const rawGigId = c.req.param('gigId');
  if (!rawGigId) {
    return c.json({ error: 'invalid_request', message: 'Missing gigId' }, 400);
  }
  const gigId: string = rawGigId;
  const agent = c.get('agent');

  const check = await assertParticipant(gigId, agent.id);
  if (!check.ok) {
    return c.json({ error: check.error, message: check.message }, check.status);
  }

  const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);

  const rows = await db
    .select({
      id: orderMessages.id,
      gigId: orderMessages.gigId,
      senderAgentId: orderMessages.senderAgentId,
      recipientAgentId: orderMessages.recipientAgentId,
      content: orderMessages.content,
      fileUrl: orderMessages.fileUrl,
      fileName: orderMessages.fileName,
      fileSize: orderMessages.fileSize,
      fileMimeType: orderMessages.fileMimeType,
      createdAt: orderMessages.createdAt,
    })
    .from(orderMessages)
    .where(eq(orderMessages.gigId, gigId))
    .orderBy(asc(orderMessages.createdAt))
    .limit(limit);

  return c.json({
    gig_id: gigId,
    messages: rows.map((r) => ({
      id: r.id,
      gig_id: r.gigId,
      sender_agent_id: r.senderAgentId,
      recipient_agent_id: r.recipientAgentId,
      content: r.content,
      file_url: r.fileUrl,
      file_name: r.fileName,
      file_size: r.fileSize,
      file_mime_type: r.fileMimeType,
      created_at: r.createdAt,
    })),
    total: rows.length,
  });
});

export { orderMessagesRouter };
