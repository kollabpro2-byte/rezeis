import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SettingsService } from '../../settings/services/settings.service';
import { UploadAttachmentDto } from '../dto/attachment.dto';
import { CreateGuestTicketDto, GuestReplyDto } from '../dto/guest-support.dto';
import { GuestGateService } from '../services/guest-gate.service';
import { SupportAiDispatchService, type SupportAiRouting } from '../services/support-ai-dispatch.service';
import { SupportGuestService } from '../services/support-guest.service';
import { AttachGuestDto } from '../dto/guest-support.dto';
import { GUEST_LOCALE_HEADER, readGuestLocale } from '../utils/guest-letter-language.util';
import { AttachmentValidationError } from '../utils/support-attachment.util';

/** Header reiwa uses to relay the raw, server-bound guest token. */
const GUEST_TOKEN_HEADER = 'x-support-guest-token';
/** Optional header reiwa uses to relay the visitor's IP (hashed for abuse review). */
const GUEST_IP_HEADER = 'x-support-client-ip';

/**
 * InternalGuestSupportController
 * ──────────────────────────────
 * reiwa-facing surface for ANONYMOUS (guest) support conversations.
 *
 * Auth: `InternalAdminAuthGuard` (api_token) protects the reiwa↔rezeis hop.
 * Conversation authorization is bound ENTIRELY to the server-side guest token
 * relayed in `X-Support-Guest-Token` — there is no ticket/user id in the path
 * or body, so a client cannot assert someone else's conversation. Any
 * unresolved token (unknown / expired / closed) yields a uniform 404.
 */
@ApiTags('internal/support/guest')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/support/guest')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalGuestSupportController {
  public constructor(
    private readonly guestService: SupportGuestService,
    private readonly systemEvents: SystemEventsService,
    private readonly settingsService: SettingsService,
    private readonly guestGate: GuestGateService,
    /**
     * The AI assistant's dispatch. Last and `@Optional()` so positional
     * construction in the specs keeps working; without it every guest ticket
     * is an operator's, as before guests were handed to the assistant.
     */
    @Optional()
    private readonly supportAi?: SupportAiDispatchService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Runtime config for the reiwa edge (enabled + Turnstile)' })
  public getConfig(): Promise<{
    readonly enabled: boolean;
    readonly turnstileSiteKey: string;
    readonly turnstileSecret: string | null;
  }> {
    return this.settingsService.getSupportRuntimeConfig();
  }

  @Post()
  @ApiOperation({ summary: 'Open an anonymous guest support conversation' })
  public async create(
    @Body() body: CreateGuestTicketDto,
    @Headers(GUEST_IP_HEADER) clientIp: string | undefined,
    // The guest page's language, for the letters — a header, because a body
    // field an older panel does not declare fails the request there
    // (`guest-letter-language.util.ts`).
    @Headers(GUEST_LOCALE_HEADER) locale?: string,
  ): Promise<GuestCreateResponse> {
    const runtime = await this.settingsService.getSupportRuntimeConfig();
    if (!runtime.enabled) throw new NotFoundException('Conversation not found');

    // ── The gate ────────────────────────────────────────────────────────
    // A device an operator silenced by hand is turned away with the SAME
    // answer a disabled support surface gives. Not politeness — a distinct
    // refusal is an oracle: it tells whoever is testing which of their
    // machines is known to us, which is the one thing that makes churning
    // through devices cheap for them.
    const verdict = await this.guestGate.evaluate({
      installId: body.installId ?? null,
      deviceHash: body.deviceHash ?? null,
      // The address the edge saw. On this product it is the stronger of the
      // two signals: it comes from the VPN connection itself rather than from
      // a browser that can decline to answer.
      clientIp: clientIp ?? null,
    });
    if (verdict.kind === 'silenced') {
      throw new NotFoundException('Conversation not found');
    }

    const subject = body.subject.trim();
    const { token, ticketId, messageId } = await this.guestService.createConversation({
      subject,
      message: body.message.trim(),
      email: body.email?.trim() || null,
      ipHash: hashIp(clientIp),
      // NORMALISED, not raw. The gate looks these values up normalised and the
      // repeat counter counts them normalised; storing the raw spelling meant a
      // client sending mixed case was filed under a value neither could ever
      // find again, and its pest signal read zero for ever.
      installId: verdict.installId,
      deviceHash: verdict.deviceHash,
      flaggedReason: verdict.flaggedReason,
      locale: readGuestLocale(locale),
    });
    const routing = await this.routeGuestMessage(ticketId, messageId ?? null, 'open');
    this.announce(
      EVENT_TYPES.SUPPORT_TICKET_CREATED,
      `Гостевой тикет: ${subject}`,
      // The mark travels into the event too, so a flooded queue is visible in
      // the operator's own stream rather than only when somebody opens tickets.
      { ticketId, subject, guest: true, flagged: verdict.flaggedReason !== null },
      routing,
    );
    const ticket = await this.guestService.getConversation(token);
    return {
      token,
      resumeCode: token,
      ticket: ticket !== null ? serializeGuestTicket(ticket) : null,
    };
  }

  /**
   * The conversation bound to the token. When the token was a reply letter's
   * link, the answer also carries `deviceToken`: the conversation's durable
   * credential, which reiwa stores as the device cookie INSTEAD of the link's
   * token — that one dies at the operator's next reply. reiwa never passes the
   * field on to the browser.
   */
  @Get()
  @ApiOperation({ summary: 'Fetch the conversation bound to the guest token' })
  public async get(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
  ): Promise<SerializedGuestTicket & { readonly deviceToken?: string }> {
    const found = await this.guestService.getConversationForDevice(token ?? '');
    if (found === null) throw new NotFoundException('Conversation not found');
    const ticket = serializeGuestTicket(found.ticket);
    return found.deviceToken === null ? ticket : { ...ticket, deviceToken: found.deviceToken };
  }

  @Post('reply')
  @ApiOperation({ summary: 'Append a guest reply to the bound conversation' })
  public async reply(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: GuestReplyDto,
    @Headers(GUEST_LOCALE_HEADER) locale?: string,
  ): Promise<SerializedGuestTicket> {
    const ticket = await this.guestService.reply(token ?? '', body.content.trim(), readGuestLocale(locale));
    if (ticket === null) throw new NotFoundException('Conversation not found');
    const entity = ticket as GuestTicketEntity;
    const routing = await this.routeGuestMessage(entity.id, readClientMessageId(ticket), 'message');
    this.announce(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'Ответ гостя в обращении',
      // WHICH conversation. Without the id the card said a guest had replied
      // somewhere, and the admin push had nothing to deep-link to — it keys
      // `/support-tickets?ticket=` off this exact field.
      {
        guest: true,
        ticketId: entity.id,
        subject: entity.subject,
      },
      routing,
    );
    return serializeGuestTicket(ticket);
  }

  @Post('close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Visitor closes (archives) their own conversation' })
  public async close(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
  ): Promise<{ ok: true }> {
    const ok = await this.guestService.close(token ?? '');
    if (!ok) throw new NotFoundException('Conversation not found');
    return { ok: true };
  }

  @Post('attach')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Attach the guest conversation to a logged-in account' })
  public async attach(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: AttachGuestDto,
  ): Promise<{ ok: true }> {
    const ok = await this.guestService.attachToUser(token ?? '', body.userRef.trim());
    if (!ok) throw new NotFoundException('Conversation not found');
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'SUPPORT',
      'Гостевой тикет привязан к аккаунту',
      { guest: true },
    );
    return { ok: true };
  }

  @Post('attachments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a file to the bound conversation' })
  public async upload(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: UploadAttachmentDto,
  ): Promise<SerializedGuestTicket> {
    let ticket: unknown | null;
    try {
      ticket = await this.guestService.addAttachment(token ?? '', {
        filename: body.filename,
        mimeType: body.mimeType,
        content: body.content,
        dataBase64: body.dataBase64,
      });
    } catch (err: unknown) {
      throw mapAttachmentError(err);
    }
    if (ticket === null) throw new NotFoundException('Conversation not found');
    const entity = ticket as GuestTicketEntity;
    // The assistant cannot see a file; it reads the name and usually hands
    // the thread over. That is its call, not this route's — the same as a
    // signed-in customer's attachment.
    const routing = await this.routeGuestMessage(entity.id, readClientMessageId(ticket), 'message');
    this.announce(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'Гость прикрепил файл в обращении',
      // Same fields as the signed-in counterpart in `InternalUserSupportController`.
      { guest: true, ticketId: entity.id },
      routing,
    );
    return serializeGuestTicket(ticket);
  }

  @Get('attachments/:attachmentId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Stream an attachment on the bound conversation' })
  public async download(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Param('attachmentId') attachmentId: string,
  ): Promise<StreamableFile> {
    const file = await this.guestService.streamAttachment(token ?? '', attachmentId);
    if (file === null) throw new NotFoundException('Attachment not found');
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.sizeBytes,
      disposition: `inline; filename="${encodeURIComponent(file.filename)}"`,
    });
  }

  /**
   * Hand one visitor message to the assistant when it can answer.
   *
   * `open` is a new conversation (`takeNewTicket`); `message` is a later line
   * or a file (`onClientMessage`). No message id — a stub that did not return
   * one — stays with the operators rather than queueing an answer to nothing.
   * Absent dispatch is the same: every guest ticket is an operator's.
   */
  private async routeGuestMessage(
    ticketId: string,
    messageId: string | null,
    kind: 'open' | 'message',
  ): Promise<SupportAiRouting> {
    if (this.supportAi === undefined || messageId === null || messageId.length === 0) return 'operator';
    return kind === 'open'
      ? this.supportAi.takeNewTicket(ticketId, messageId)
      : this.supportAi.onClientMessage(ticketId, messageId);
  }

  /**
   * Log the visitor's message and, on the ordinary path, alert the operators.
   *
   * On a thread the AI assistant leads, the event is still written — it is the
   * audit log's trace and what refreshes an open «Тикеты» page — but without
   * the Telegram card (`skipTelegram`) and marked `aiHandling`, which keeps it
   * out of the push and the bell. The operators hear about such a thread when
   * the assistant hands it over. One path or the other, never both: an
   * assistant-led guest ticket must not also raise the ordinary «new ticket» /
   * «guest replied» card.
   */
  private announce(
    type: string,
    message: string,
    metadata: Record<string, unknown>,
    routing: SupportAiRouting,
  ): void {
    if (routing === 'operator') {
      this.systemEvents.info(type, 'SUPPORT', message, metadata);
      return;
    }
    this.systemEvents.emit({
      type,
      category: 'SUPPORT',
      severity: 'INFO',
      message,
      metadata: { ...metadata, aiHandling: true },
      skipTelegram: true,
    });
  }
}

// ── Serialization (guest-safe; UPPERCASE enums → lowercase SPA contract) ──────

interface GuestTicketEntity {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly channel: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly messages?: ReadonlyArray<{
    readonly id: string;
    readonly authorType: string;
    readonly content: string;
    readonly createdAt: Date;
    readonly metadata?: unknown;
    readonly attachments?: ReadonlyArray<{
      readonly id: string;
      readonly filename: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      // Required, not optional: an optional field let a missing Prisma
      // `select` compile clean and ship a feature that did nothing.
      readonly purgedAt: Date | string | null;
    }>;
  }>;
}

interface SerializedGuestAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly purgedAt: Date | string | null;
}

interface SerializedGuestTicket {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly channel: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly authorType: string;
    readonly content: string;
    readonly createdAt: string;
    readonly metadata: unknown;
    readonly attachments: ReadonlyArray<SerializedGuestAttachment>;
  }>;
}

interface GuestCreateResponse {
  readonly token: string;
  readonly resumeCode: string;
  readonly ticket: SerializedGuestTicket | null;
}

/**
 * The visitor message just stored on this thread.
 *
 * `clientMessageId` is stamped by `SupportGuestService` from the insert.
 * The fallback — the last USER line — covers a ticket read that was not
 * stamped. An ADMIN/SYSTEM last line is not a visitor message and is not
 * dispatched: that is what stops an assistant reply, which is stored as
 * ADMIN, from being queued again if it were ever re-read through here.
 */
function readClientMessageId(ticket: unknown): string | null {
  if (typeof ticket !== 'object' || ticket === null) return null;
  const stamped = (ticket as { readonly clientMessageId?: unknown }).clientMessageId;
  if (typeof stamped === 'string' && stamped.length > 0) return stamped;
  const messages = (ticket as GuestTicketEntity).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last === undefined || last.authorType !== 'USER') return null;
  return typeof last.id === 'string' && last.id.length > 0 ? last.id : null;
}

function serializeGuestTicket(ticket: unknown): SerializedGuestTicket {
  const t = ticket as GuestTicketEntity;
  return {
    id: t.id,
    subject: t.subject,
    status: t.status.toLowerCase(),
    channel: t.channel.toLowerCase(),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    messages: (t.messages ?? []).map((m) => ({
      id: m.id,
      authorType: m.authorType.toLowerCase(),
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      metadata: m.metadata ?? null,
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        // Purged: the bytes are gone, the record is not. Both surfaces
        // render this as «файл удалён» rather than a link that 404s.
        purgedAt: a.purgedAt ?? null,
      })),
    })),
  };
}

/** Map attachment validation failures to 413 (oversize) / 415 (other). */
function mapAttachmentError(err: unknown): HttpException {
  if (err instanceof AttachmentValidationError) {
    if (err.reason === 'too-large') {
      return new HttpException('Attachment exceeds the size limit', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    return new HttpException('Attachment type is not allowed', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  }
  if (err instanceof HttpException) return err;
  return new HttpException('Attachment could not be stored', HttpStatus.INTERNAL_SERVER_ERROR);
}

/** SHA-256 of the visitor IP for abuse review — never store the raw IP. */
function hashIp(ip: string | undefined): string | null {
  const trimmed = (ip ?? '').split(',')[0]?.trim() ?? '';
  if (trimmed.length === 0) return null;
  return createHash('sha256').update(trimmed).digest('hex');
}
