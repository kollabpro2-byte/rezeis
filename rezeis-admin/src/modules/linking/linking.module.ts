import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { EmailModule } from '../email/email.module';
import { QuestsModule } from '../quests/quests.module';
import { InternalLinkingController } from './controllers/internal-linking.controller';
import { LinkingService } from './services/linking.service';

/**
 * LinkingModule
 * ─────────────
 * Owns the four link/* internal endpoints used by the SPA settings page
 * and the reiwa bot to attach optional identity channels (Telegram,
 * verified email) to an existing `reiwa_id`.
 */
@Module({
  imports: [AuthModule, EmailModule, QuestsModule],
  controllers: [InternalLinkingController],
  providers: [LinkingService],
  exports: [LinkingService],
})
export class LinkingModule {}
