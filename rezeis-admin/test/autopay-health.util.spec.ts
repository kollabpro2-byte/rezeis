import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderSubscriptionStatus } from '@prisma/client';

import {
  DEFAULT_STALE_DAYS,
  STALLED_AFTER_MS,
  SUPERSEDED_BY_NEWER_AUTOPAY,
  autopayHealth,
  cancelBackoffMs,
  isStalledAutopay,
  needsManualProviderCancel,
  providerCancelSupported,
  readAutocancelMode,
  readStaleCleanupMode,
  readStaleDays,
  supersededByManualPayment,
} from '../src/modules/payments/utils/autopay-health.util';
import { readAutopayFlags } from '../src/modules/payments/utils/autopay-flags.util';
import { readAntilopayTimestamp } from '../src/modules/payments/utils/antilopay-recurrent.util';

/**
 * Здоровье автоподписки, backoff отмены, флаги и чтение времени Antilopay.
 * Всё чистое, поэтому проверяется без базы.
 */
describe('autopay-health.util', () => {
  const now = new Date('2026-11-20T15:00:00.000Z');

  describe('autopayHealth', () => {
    it('marks PROCESSING with a stale date as stalled (group A)', () => {
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.ACTIVE,
          providerStatus: 'PROCESSING',
          nextChargeAt: new Date('2026-10-15T09:00:00.000Z'),
          now,
        }),
        'STALLED',
      );
    });

    it('marks ACTIVE_FAILED with a stale date as stalled (group B)', () => {
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.PAST_DUE,
          providerStatus: 'ACTIVE_FAILED',
          nextChargeAt: new Date('2026-11-01T09:00:00.000Z'),
          now,
        }),
        'STALLED',
      );
    });

    /** Граница 24 часа: сутки — уже завис, на час меньше — ещё нет. */
    it('switches to stalled exactly over 24 hours', () => {
      const stale = new Date(now.getTime() - STALLED_AFTER_MS - 1000);
      const fresh = new Date(now.getTime() - STALLED_AFTER_MS + 60_000);
      assert.equal(
        autopayHealth({ status: ProviderSubscriptionStatus.ACTIVE, providerStatus: 'PROCESSING', nextChargeAt: stale, now }),
        'STALLED',
      );
      // Не «завис», но дата уже прошла — это рассинхрон, а не здоровье.
      assert.equal(
        autopayHealth({ status: ProviderSubscriptionStatus.ACTIVE, providerStatus: 'PROCESSING', nextChargeAt: fresh, now }),
        'DESYNC',
      );
    });

    it('keeps a healthy ACTIVE autopay OK', () => {
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.ACTIVE,
          providerStatus: 'ACTIVE',
          nextChargeAt: new Date('2026-12-20T09:00:00.000Z'),
          now,
        }),
        'OK',
      );
    });

    it('reports PAST_DUE even when the provider date is not stale yet', () => {
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.PAST_DUE,
          providerStatus: 'ACTIVE_FAILED',
          nextChargeAt: new Date('2026-11-20T12:00:00.000Z'),
          now,
        }),
        'PAST_DUE',
      );
    });

    /** ACTIVE, но дата прошла без признаков PROCESSING — ждём синхронизации. */
    it('reports DESYNC for an ACTIVE row whose date has passed', () => {
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.ACTIVE,
          providerStatus: 'ACTIVE',
          nextChargeAt: new Date('2026-11-20T10:00:00.000Z'),
          now,
        }),
        'DESYNC',
      );
    });

    it('treats cancelled and pending rows as OK for the health badge', () => {
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.CANCELLED,
          providerStatus: 'CANCEL',
          nextChargeAt: null,
          now,
        }),
        'OK',
      );
      assert.equal(
        autopayHealth({
          status: ProviderSubscriptionStatus.PENDING,
          providerStatus: 'CREATED',
          nextChargeAt: null,
          now,
        }),
        'OK',
      );
    });

    it('has a helper for the grace and sweep paths', () => {
      assert.equal(
        isStalledAutopay({
          status: ProviderSubscriptionStatus.ACTIVE,
          providerStatus: 'PROCESSING',
          nextChargeAt: new Date('2026-10-15T09:00:00.000Z'),
          now,
        }),
        true,
      );
    });
  });

  describe('cancelBackoffMs', () => {
    it('grows 10м → 30м → 2ч → 6ч → 24ч and stops there', () => {
      assert.equal(cancelBackoffMs(0), 10 * 60 * 1000);
      assert.equal(cancelBackoffMs(1), 30 * 60 * 1000);
      assert.equal(cancelBackoffMs(2), 2 * 60 * 60 * 1000);
      assert.equal(cancelBackoffMs(3), 6 * 60 * 60 * 1000);
      assert.equal(cancelBackoffMs(4), 24 * 60 * 60 * 1000);
      assert.equal(cancelBackoffMs(50), 24 * 60 * 60 * 1000);
      assert.equal(cancelBackoffMs(-3), 10 * 60 * 1000);
    });
  });

  describe('readAutocancelMode', () => {
    it('accepts the three modes and falls back to mark', () => {
      assert.equal(readAutocancelMode('off'), 'off');
      assert.equal(readAutocancelMode(' CANCEL '), 'cancel');
      assert.equal(readAutocancelMode('mark'), 'mark');
      assert.equal(readAutocancelMode('anything'), 'mark');
      assert.equal(readAutocancelMode(undefined), 'mark');
    });
  });

  describe('readAntilopayTimestamp', () => {
    it('reads a zone-less time as Europe/Moscow, not UTC', () => {
      // Antilopay: 18:04 MSK — это 15:04 UTC, а не 18:04 UTC.
      assert.equal(
        readAntilopayTimestamp('2026-11-20 18:04:00')?.toISOString(),
        '2026-11-20T15:04:00.000Z',
      );
    });

    it('keeps microseconds and accepts the T form', () => {
      assert.equal(
        readAntilopayTimestamp('2026-11-20 18:04:00.123456')?.toISOString(),
        '2026-11-20T15:04:00.123Z',
      );
      assert.equal(
        readAntilopayTimestamp('2026-11-20T18:04:00')?.toISOString(),
        '2026-11-20T15:04:00.000Z',
      );
    });

    it('respects an explicit zone when the provider sends one', () => {
      assert.equal(
        readAntilopayTimestamp('2026-11-20T18:04:00.000Z')?.toISOString(),
        '2026-11-20T18:04:00.000Z',
      );
    });

    it('returns null for anything unusable', () => {
      assert.equal(readAntilopayTimestamp(''), null);
      assert.equal(readAntilopayTimestamp('not a time'), null);
      assert.equal(readAntilopayTimestamp(undefined), null);
    });
  });

  describe('ежедневная уборка и режимы', () => {
    it('читает режим уборки и всё непонятное считает безопасным dry-run', () => {
      assert.equal(readStaleCleanupMode('apply'), 'apply');
      assert.equal(readStaleCleanupMode('off'), 'off');
      assert.equal(readStaleCleanupMode('dry-run'), 'dry-run');
      // Опечатка в переменной окружения не должна включать отмены.
      assert.equal(readStaleCleanupMode('apply!'), 'dry-run');
      assert.equal(readStaleCleanupMode(undefined), 'dry-run');
    });

    it('читает порог дней и отбрасывает мусор', () => {
      assert.equal(readStaleDays('6'), 6);
      assert.equal(readStaleDays(3, 6), 3);
      assert.equal(readStaleDays('0'), 6);
      assert.equal(readStaleDays('-2'), 6);
      assert.equal(readStaleDays('999'), 6);
      assert.equal(readStaleDays('abc'), 6);
    });

    it('флаги по умолчанию ничего не отменяют и ничего не скрывают', () => {
      const flags = readAutopayFlags({} as NodeJS.ProcessEnv);
      assert.equal(flags.autocancelMode, 'mark');
      assert.equal(flags.autocancelOnManualRenew, 'mark');
      assert.equal(flags.staleCleanupMode, 'dry-run');
      assert.equal(flags.staleDays, DEFAULT_STALE_DAYS);
    });

    it('флаги читаются из окружения', () => {
      const flags = readAutopayFlags({
        AUTOPAY_AUTOCANCEL_MODE: 'off',
        AUTOPAY_AUTOCANCEL_ON_MANUAL_RENEW: 'cancel',
        AUTOPAY_STALE_CLEANUP_MODE: 'apply',
        AUTOPAY_STALE_DAYS: '10',
      } as NodeJS.ProcessEnv);
      assert.deepEqual(flags, {
        autocancelMode: 'off',
        autocancelOnManualRenew: 'cancel',
        staleCleanupMode: 'apply',
        staleDays: 10,
      });
    });
  });

  describe('что провайдер вообще отменяет', () => {
    it('ACTIVE и ACTIVE_FAILED отменяются, PROCESSING — нет', () => {
      assert.equal(providerCancelSupported('ACTIVE'), true);
      assert.equal(providerCancelSupported('active_failed'), true);
      assert.equal(providerCancelSupported('PROCESSING'), false);
      assert.equal(providerCancelSupported('CANCEL'), false);
      assert.equal(providerCancelSupported(null), false);
    });

    it('PROCESSING требует ручной отмены в личном кабинете', () => {
      assert.equal(needsManualProviderCancel('PROCESSING'), true);
      assert.equal(needsManualProviderCancel('processing'), true);
      assert.equal(needsManualProviderCancel('ACTIVE'), false);
      assert.equal(needsManualProviderCancel(null), false);
    });
  });

  describe('причины «лишней» строки', () => {
    it('ручная оплата называет платёж, которым продлили', () => {
      assert.equal(
        supersededByManualPayment('tx-42'),
        'superseded: renewed by manual payment tx-42',
      );
    });

    it('более новая автоподписка описана отдельной причиной', () => {
      assert.match(SUPERSEDED_BY_NEWER_AUTOPAY, /^superseded: newer live autopay/);
    });
  });
});
