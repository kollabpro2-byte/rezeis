import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderSubscriptionStatus } from '@prisma/client';

import {
  STALLED_AFTER_MS,
  autopayHealth,
  cancelBackoffMs,
  isStalledAutopay,
  readAutocancelMode,
} from '../src/modules/payments/utils/autopay-health.util';
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
});
