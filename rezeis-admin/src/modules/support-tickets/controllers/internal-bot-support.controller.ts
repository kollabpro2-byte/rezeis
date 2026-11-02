import { Body, Controller, Param, Post, UseGuards, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SupportTicketsService } from '../services/support-tickets.service';
import { SupportAttachmentService } from '../services/support-attachment.service';

/**
 * Internal endpoint for the support AI bridge (Grok bot).
 * Accepts API token (InternalAdminAuthGuard) and writes as ADMIN.
 */
@ApiTags('Internal')
@Controller('internal/bot/support')
@UseGuards(InternalAdminAuthGuard)
export class InternalBotSupportController {
  constructor(
    private readonly tickets: SupportTicketsService,
    private readonly attachments: SupportAttachmentService,
  ) {}

  @Post(':ticketId/reply')
  @HttpCode(HttpStatus.CREATED)
  async reply(
    @Param('ticketId') ticketId: string,
    @Body() body: { content?: string },
  ) {
    const content = (body.content ?? '').trim();
    if (!content) throw new BadRequestException('content required');
    await this.tickets.getById(ticketId);
    await this.tickets.addMessage({
      ticketId,
      authorType: 'ADMIN',
      authorId: null,
      content,
    });
    return { ok: true };
  }

  @Post(':ticketId/attachment')
  @HttpCode(HttpStatus.CREATED)
  async attachment(
    @Param('ticketId') ticketId: string,
    @Body() body: { filename?: string; mimeType?: string; dataBase64?: string; content?: string },
  ) {
    const filename = (body.filename ?? '').trim();
    const dataBase64 = (body.dataBase64 ?? '').trim();
    if (!filename || !dataBase64) throw new BadRequestException('filename and dataBase64 required');
    await this.tickets.getById(ticketId);
    await this.attachments.storeForMessage({
      ticketId,
      authorType: 'ADMIN',
      authorId: null,
      content: body.content,
      filename,
      declaredMime: body.mimeType,
      dataBase64,
    });
    return { ok: true };
  }

  @Post(':ticketId/close')
  @HttpCode(HttpStatus.OK)
  async close(@Param('ticketId') ticketId: string) {
    await this.tickets.getById(ticketId);
    await this.tickets.close({ ticketId, closedBy: "grok-bot" });
    return { ok: true };
  }

}
