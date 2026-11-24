import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalGuestSupportController } from '../src/modules/support-tickets/controllers/internal-guest-support.controller';
import { CreateGuestTicketDto, GuestReplyDto } from '../src/modules/support-tickets/dto/guest-support.dto';
import type { SupportAiRouting } from '../src/modules/support-tickets/services/support-ai-dispatch.service';

/**
 * reiwa-facing guest controller (Phase 2). Verifies that authorization is
 * derived ONLY from the X-Support-Guest-Token header (no path/body id), that
 * unresolved tokens yield a uniform 404, and that SUPPORT events fire.
 */

const TICKET_ENTITY = {
  id: 't-1',
  subject: 'Payment failed',
  status: 'OPEN',
  channel: 'GUEST',
  createdAt: new Date('2026-06-17T10:00:00.000Z'),
  updatedAt: new Date('2026-06-17T10:05:00.000Z'),
  messages: [
    { id: 'm-1', authorType: 'USER', content: 'help', createdAt: new Date('2026-06-17T10:00:00.000Z') },
    { id: 'm-2', authorType: 'ADMIN', content: 'on it', createdAt: new Date('2026-06-17T10:05:00.000Z') },
  ],
};

function build(opts: {
  readonly takeNewTicket?: SupportAiRouting;
  readonly onClientMessage?: SupportAiRouting;
  /** When false, the controller is built without dispatch, as the older specs are. */
  readonly assistant?: boolean;
} = {}) {
  const calls = {
    createConversation: [] as unknown[],
    getConversation: [] as string[],
    reply: [] as Array<{ token: string; content: string }>,
    close: [] as string[],
    events: [] as Array<{ type: string; metadata: Record<string, unknown> }>,
    emits: [] as Array<{ skipTelegram?: boolean; metadata?: Record<string, unknown> }>,
    ai: [] as Array<{ method: string; ticketId: string; messageId: string }>,
  };
  const guestService = {
    createConversation: async (input: unknown) => {
      calls.createConversation.push(input);
      return { token: 'tok-abc', ticketId: 't-1', messageId: 'm-open' };
    },
    getConversation: async (token: string) => {
      calls.getConversation.push(token);
      return token === 'tok-abc' ? TICKET_ENTITY : null;
    },
    // What `GET` asks since a letter's link is exchanged for the device
    // credential (`support-guest-device-credential.spec.ts`); logged with the
    // other conversation reads.
    getConversationForDevice: async (token: string) => {
      calls.getConversation.push(token);
      return token === 'tok-abc' ? { ticket: TICKET_ENTITY, deviceToken: null } : null;
    },
    reply: async (token: string, content: string) => {
      calls.reply.push({ token, content });
      return token === 'tok-abc' ? { ...TICKET_ENTITY, clientMessageId: 'm-guest' } : null;
    },
    close: async (token: string) => {
      calls.close.push(token);
      return token === 'tok-abc';
    },
  };
  const systemEvents = {
    info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
      calls.events.push({ type, metadata });
    },
    emit: (event: { skipTelegram?: boolean; metadata?: Record<string, unknown> }) => {
      calls.emits.push(event);
    },
  };
  const supportAi =
    opts.assistant === true || opts.takeNewTicket !== undefined || opts.onClientMessage !== undefined
      ? {
          takeNewTicket: async (ticketId: string, messageId: string) => {
            calls.ai.push({ method: 'takeNewTicket', ticketId, messageId });
            return opts.takeNewTicket ?? 'operator';
          },
          onClientMessage: async (ticketId: string, messageId: string) => {
            calls.ai.push({ method: 'onClientMessage', ticketId, messageId });
            return opts.onClientMessage ?? 'operator';
          },
        }
      : undefined;
  const settings = {
    getSupportRuntimeConfig: async () => ({ enabled: true, turnstileSiteKey: '', turnstileSecret: null }),
  };
  const controller = new InternalGuestSupportController(
    guestService as never,
    systemEvents as never,
    settings as never,
    // The gate. Allowing-and-unmarked is the answer for a visitor nobody
    // recognises, which is what these cases are about; the gate's own
    // behaviour is pinned in `guest-support-gate.spec.ts`.
    { evaluate: async () => ({ kind: 'allow', flaggedReason: null }) } as never,
    supportAi as never,
  );
  return { controller, calls };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'NotFoundException';
}

describe('InternalGuestSupportController', () => {
  it('creates a conversation, returns the token + serialized ticket, fires SUPPORT_TICKET_CREATED', async () => {
    const { controller, calls } = build();
    const body: CreateGuestTicketDto = { subject: ' Payment failed ', message: ' help ', email: 'a@b.co' };
    const res = await controller.create(body, '203.0.113.9');
    assert.equal(res.token, 'tok-abc');
    assert.equal(res.resumeCode, 'tok-abc');
    assert.equal(res.ticket?.status, 'open');
    assert.equal(res.ticket?.channel, 'guest');
    assert.equal(res.ticket?.messages.length, 2);
    assert.equal(res.ticket?.messages[1].authorType, 'admin');
    // event fired with guest marker
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].metadata.guest, true);
    // subject/message trimmed and forwarded; ip forwarded for hashing
    const created = calls.createConversation[0] as { subject: string; message: string; email: string | null; ipHash: string | null };
    assert.equal(created.subject, 'Payment failed');
    assert.equal(created.message, 'help');
    assert.equal(created.email, 'a@b.co');
    assert.ok(created.ipHash && created.ipHash.length === 64); // sha256 hex
  });

  it('get resolves ONLY by the header token', async () => {
    const { controller, calls } = build();
    const ticket = await controller.get('tok-abc');
    assert.equal(ticket.id, 't-1');
    assert.deepEqual(calls.getConversation, ['tok-abc']);
  });

  it('get returns a uniform 404 for missing/unknown token', async () => {
    const { controller } = build();
    await assert.rejects(() => controller.get(undefined), isNotFound);
    await assert.rejects(() => controller.get('wrong'), isNotFound);
  });

  it('reply appends only with a valid token and fires the user-reply event', async () => {
    const { controller, calls } = build();
    const body: GuestReplyDto = { content: ' any update? ' };
    const ticket = await controller.reply('tok-abc', body);
    assert.equal(ticket.id, 't-1');
    assert.deepEqual(calls.reply[0], { token: 'tok-abc', content: 'any update?' });
    assert.equal(calls.events[0].type, 'support.ticket_user_reply');
    await assert.rejects(() => controller.reply('wrong', body), isNotFound);
  });

  it('names the conversation on the reply and attachment events', async () => {
    // Without `ticketId` the operator's card said a guest had replied somewhere,
    // and the admin push — which deep-links `/support-tickets?ticket=` off this
    // exact field — opened the ticket list instead of the ticket.
    const { controller, calls } = build();
    await controller.reply('tok-abc', { content: 'still broken' });
    assert.equal(calls.events[0].metadata.ticketId, 't-1');
    assert.equal(calls.events[0].metadata.subject, 'Payment failed');

    const withUpload = build();
    (withUpload.controller as unknown as { guestService: { addAttachment: unknown } }).guestService.addAttachment =
      async () => TICKET_ENTITY;
    await withUpload.controller.upload('tok-abc', {
      filename: 'screen.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    } as never);
    assert.equal(withUpload.calls.events[0].type, 'support.ticket_user_reply');
    assert.equal(withUpload.calls.events[0].metadata.ticketId, 't-1');
  });

  it('close returns ok for a valid token and 404 otherwise', async () => {
    const { controller } = build();
    assert.deepEqual(await controller.close('tok-abc'), { ok: true });
    await assert.rejects(() => controller.close('wrong'), isNotFound);
  });

  it('sends a new guest ticket to the assistant and does not also alert the operators', async () => {
    const { controller, calls } = build({ takeNewTicket: 'assistant' });
    const body: CreateGuestTicketDto = { subject: ' Payment failed ', message: ' help ' };
    await controller.create(body, '203.0.113.9');
    assert.deepEqual(calls.ai, [{ method: 'takeNewTicket', ticketId: 't-1', messageId: 'm-open' }]);
    assert.equal(calls.events.length, 0, 'no ordinary new-ticket card');
    assert.equal(calls.emits.length, 1);
    assert.equal(calls.emits[0].skipTelegram, true);
    assert.equal(calls.emits[0].metadata?.aiHandling, true);
    assert.equal(calls.emits[0].metadata?.guest, true);
    assert.equal(calls.emits[0].metadata?.ticketId, 't-1');
  });

  it('keeps a new guest ticket with the operators when the assistant is off', async () => {
    const { controller, calls } = build({ takeNewTicket: 'operator' });
    const body: CreateGuestTicketDto = { subject: 's', message: 'm' };
    await controller.create(body, undefined);
    assert.deepEqual(calls.ai, [{ method: 'takeNewTicket', ticketId: 't-1', messageId: 'm-open' }]);
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].metadata.guest, true);
    assert.equal(calls.events[0].metadata.aiHandling, undefined);
    assert.equal(calls.emits.length, 0, 'the operator card is the one info() emit, not a second one');
  });

  it('sends a guest reply to the assistant without a second operator card', async () => {
    const { controller, calls } = build({ onClientMessage: 'assistant' });
    await controller.reply('tok-abc', { content: ' still broken ' });
    assert.deepEqual(calls.ai, [{ method: 'onClientMessage', ticketId: 't-1', messageId: 'm-guest' }]);
    assert.equal(calls.events.length, 0);
    assert.equal(calls.emits.length, 1);
    assert.equal(calls.emits[0].skipTelegram, true);
    assert.equal(calls.emits[0].metadata?.guest, true);
    assert.equal(calls.emits[0].metadata?.ticketId, 't-1');
    assert.equal(calls.emits[0].metadata?.aiHandling, true);
  });

  it('alerts the operators once for a guest reply the assistant does not take', async () => {
    const { controller, calls } = build({ onClientMessage: 'operator' });
    await controller.reply('tok-abc', { content: 'hello' });
    assert.equal(calls.ai[0]?.method, 'onClientMessage');
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].type, 'support.ticket_user_reply');
    assert.equal(calls.events[0].metadata.guest, true);
    assert.equal(calls.emits.length, 0);
  });

  it('sends a guest file to the assistant the same way a signed-in attachment does', async () => {
    const { controller, calls } = build({ onClientMessage: 'assistant' });
    (controller as unknown as { guestService: { addAttachment: unknown } }).guestService.addAttachment = async () => ({
      ...TICKET_ENTITY,
      clientMessageId: 'm-file',
    });
    await controller.upload('tok-abc', {
      filename: 'screen.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    } as never);
    assert.deepEqual(calls.ai, [{ method: 'onClientMessage', ticketId: 't-1', messageId: 'm-file' }]);
    assert.equal(calls.events.length, 0);
    assert.equal(calls.emits.length, 1);
  });
});
