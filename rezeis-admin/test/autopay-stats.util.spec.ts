import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTOPAY_STATS_PERIODS,
  bucketStart,
  readStatsPeriod,
  statsBucketMs,
  statsRange,
} from '../src/modules/payments/utils/autopay-stats.util';

/**
 * Периоды статистики автопродлений и разбивка графика.
 *
 * Всё чистое: границы считаются от «сейчас», шаг бакета — от длины периода.
 * Ошибка здесь тихая — график просто покажет не то окно, поэтому проверяем
 * каждую границу.
 */
const NOW = new Date('2026-11-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('autopay-stats.util', () => {
  describe('readStatsPeriod', () => {
    it('принимает все объявленные периоды', () => {
      for (const period of AUTOPAY_STATS_PERIODS) {
        assert.equal(readStatsPeriod(period), period);
      }
    });

    it('читает регистр и пробелы', () => {
      assert.equal(readStatsPeriod('  7D '), '7d');
    });

    it('мусор и пустое значение — месяц', () => {
      assert.equal(readStatsPeriod(undefined), '30d');
      assert.equal(readStatsPeriod(''), '30d');
      assert.equal(readStatsPeriod('2w'), '30d');
      assert.equal(readStatsPeriod(42), '30d');
    });
  });

  describe('statsRange', () => {
    it('«за всё время» — без нижней границы', () => {
      const range = statsRange('all', NOW);
      assert.equal(range.from, null);
      assert.equal(range.to.toISOString(), NOW.toISOString());
    });

    it('считает длину периода в сутках', () => {
      const cases: Array<[Parameters<typeof statsRange>[0], number]> = [
        ['day', 1],
        ['3d', 3],
        ['7d', 7],
        ['14d', 14],
        ['30d', 30],
        ['90d', 90],
        ['180d', 180],
        ['365d', 365],
      ];
      for (const [period, days] of cases) {
        const from = statsRange(period, NOW).from;
        assert.notEqual(from, null);
        assert.equal(NOW.getTime() - (from as Date).getTime(), days * DAY, period);
      }
    });
  });

  describe('statsBucketMs', () => {
    it('до двух месяцев — сутки', () => {
      assert.equal(statsBucketMs(statsRange('day', NOW)), DAY);
      assert.equal(statsBucketMs(statsRange('30d', NOW)), DAY);
      // 62 суток — ещё сутки, 63 — уже неделя.
      const edge = new Date(NOW.getTime() - 61 * DAY);
      assert.equal(statsBucketMs({ period: '90d', from: edge, to: NOW }), DAY);
    });

    it('дольше двух месяцев — неделя', () => {
      assert.equal(statsBucketMs(statsRange('90d', NOW)), 7 * DAY);
      assert.equal(statsBucketMs(statsRange('365d', NOW)), 7 * DAY);
      assert.equal(statsBucketMs(statsRange('all', NOW)), 7 * DAY);
    });
  });

  describe('bucketStart', () => {
    it('округляет вниз до суток', () => {
      assert.equal(
        bucketStart(new Date('2026-11-21T12:34:56.000Z'), DAY).toISOString(),
        '2026-11-21T00:00:00.000Z',
      );
    });

    it('округляет вниз до недели', () => {
      // 2026-11-21 — суббота; неделя начинается в четверг 19.11 по эпохе UTC.
      const start = bucketStart(new Date('2026-11-21T12:00:00.000Z'), 7 * DAY);
      assert.equal(start.getTime() % (7 * DAY), 0);
      assert.ok(start.getTime() <= NOW.getTime());
      assert.ok(NOW.getTime() - start.getTime() < 7 * DAY);
    });
  });
});
