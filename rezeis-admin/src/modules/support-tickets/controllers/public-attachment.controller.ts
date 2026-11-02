import { Controller, Get, Param, Query, Res, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { SupportAttachmentService } from '../services/support-attachment.service';

@Controller('v1/support/public-attachments')
export class PublicAttachmentController {
  constructor(private readonly attachments: SupportAttachmentService) {}

  @Get(':attachmentId')
  async download(
    @Param('attachmentId') attachmentId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const expected = process.env.SUPPORT_ATTACHMENT_PUBLIC_TOKEN || '';
    if (!expected || !token || token !== expected) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    const file = await this.attachments.streamById(attachmentId);
    if (!file) {
      throw new HttpException('Attachment not found', HttpStatus.NOT_FOUND);
    }

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.filename || 'file')}"`,
    );
    file.stream.pipe(res);
  }
}
