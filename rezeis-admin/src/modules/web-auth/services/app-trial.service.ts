import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { PanelDevicesClient } from '../../remnawave/services/panel-devices.client';

const TRIAL_DAYS = 3;
const TRIAL_NAME = 'Свободный полёт';

/**
 * Three free days for a registration that came from the Android app, once per
 * device. The device is the HWID the app sends (ANDROID_ID). If that HWID is
 * already on any panel subscription — active or expired — or was already used
 * for this grant, nothing is issued.
 */
@Injectable()
export class AppTrialService {
  private readonly logger = new Logger(AppTrialService.name);
  private tableReady = false;

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly devices?: PanelDevicesClient,
    @Optional() private readonly profileSync?: ProfileSyncQueueService,
  ) {}

  public async grantIfEligible(userId: string, hwid: string | undefined): Promise<void> {
    const id = (hwid ?? '').trim();
    if (id.length < 8 || id.length > 128) return;
    try {
      await this.ensureTable();
      const seenLocally = await this.prismaService.$queryRaw<readonly { hwid: string }[]>(
        Prisma.sql`SELECT "hwid" FROM "app_trial_hwids" WHERE "hwid" = ${id} LIMIT 1`,
      );
      if (seenLocally.length > 0) {
        this.logger.log(`App trial skipped for ${userId}: HWID already used`);
        return;
      }
      if (await this.hwidOnPanel(id)) {
        await this.remember(id, userId);
        this.logger.log(`App trial skipped for ${userId}: HWID already on a subscription`);
        return;
      }
      const subscriptionId = await this.createTrial(userId);
      await this.remember(id, userId);
      this.logger.log(`App trial granted to ${userId}: subscription ${subscriptionId}`);
    } catch (err: unknown) {
      this.logger.warn(
        `App trial failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    await this.prismaService.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "app_trial_hwids" (
         "hwid" TEXT PRIMARY KEY,
         "user_id" TEXT NOT NULL,
         "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    this.tableReady = true;
  }

  private async remember(hwid: string, userId: string): Promise<void> {
    await this.prismaService.$executeRaw(
      Prisma.sql`INSERT INTO "app_trial_hwids" ("hwid", "user_id") VALUES (${hwid}, ${userId})
                 ON CONFLICT ("hwid") DO NOTHING`,
    );
  }

  private async hwidOnPanel(hwid: string): Promise<boolean> {
    if (!this.devices) return false;
    const inventory = await this.devices.listAllDevices();
    if (inventory.kind !== 'ok' || inventory.data.complete === false) {
      throw new Error('panel device list unavailable');
    }
    const needle = hwid.toLowerCase();
    return inventory.data.devices.some((row) => row.hwid.trim().toLowerCase() === needle);
  }

  private async createTrial(userId: string): Promise<string> {
    const plan = await this.prismaService.plan.findFirst({
      where: { deletedAt: null, isActive: true, isArchived: false },
      orderBy: { orderIndex: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        icon: true,
        trafficLimit: true,
        deviceLimit: true,
        trafficLimitStrategy: true,
        internalSquads: true,
        externalSquad: true,
        tag: true,
        availability: true,
      },
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const snapshot = {
      ...(plan ?? {}),
      name: TRIAL_NAME,
      source: 'app_registration',
    };
    const created = await this.prismaService.$transaction(async (tx) => {
      const subscription = await tx.subscription.create({
        data: {
          userId,
          status: SubscriptionStatus.ACTIVE,
          isTrial: true,
          planSnapshot: snapshot as Prisma.InputJsonValue,
          trafficLimit: plan?.trafficLimit ?? null,
          deviceLimit: plan?.deviceLimit ?? 1,
          internalSquads: plan?.internalSquads ?? [],
          externalSquad: plan?.externalSquad ?? null,
          startedAt: now,
          expiresAt,
        },
        select: { id: true },
      });
      const syncJob = await tx.profileSyncJob.create({
        data: {
          subscriptionId: subscription.id,
          action: 'CREATE',
          status: 'PENDING',
          payload: { source: 'APP_TRIAL' },
        },
        select: { id: true },
      });
      return { subscriptionId: subscription.id, syncJobId: syncJob.id };
    });
    try {
      await this.profileSync?.enqueue(created.syncJobId);
    } catch (err: unknown) {
      this.logger.warn(
        `App trial sync enqueue failed for ${created.subscriptionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return created.subscriptionId;
  }
}
