import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTOPAY_STATS_PERIODS,
  accumulateMoney,
  bucketStart,
  fromMinorUnits,
  readStatsPeriod,
  sharePercent,
  statsBucketMs,
  statsRange,
  toMinorUnits,
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
/** ISO-строка без «Z»-возни: попытки в базе хранят именно `toISOString()`. */
const at = (iso: string): string => new Date(iso).toISOString();

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

  describe('проценты и деньги', () => {
    it('переводит суммы в копейки и обратно без потерь', () => {
      assert.equal(toMinorUnits('299.00'), 29_900);
      assert.equal(toMinorUnits('299,5'), 29_950);
      assert.equal(toMinorUnits('не число'), 0);
      assert.equal(fromMinorUnits(29_900), '299.00');
      assert.equal(fromMinorUnits(29_950), '299.50');
    });

    it('считает долю с одним знаком и не делит на ноль', () => {
      assert.equal(sharePercent(1, 3), 33.3);
      assert.equal(sharePercent(2, 3), 66.7);
      assert.equal(sharePercent(0, 0), 0);
      // Симметрия: успех + ошибки = 100.
      assert.equal(sharePercent(1, 3) + sharePercent(2, 3), 100);
    });
  });

  describe('accumulateMoney', () => {
    const range = statsRange('30d', NOW);

    it('суммирует потенциал и полученное по валютам, считая только попытки в периоде', () => {
      const rows = [
        {
          amount: '299.00',
          currency: 'RUB',
          createdAt: new Date('2026-11-01T10:00:00Z'),
          attempts: [
            // В периоде: успешная и неуспешная.
            { at: at('2026-11-10T10:00:00Z'), ok: true, amount: '299.00' },
            { at: at('2026-11-15T10:00:00Z'), ok: false, error: 'ACTIVE_FAILED' },
            // Вне периода (старая) — не считаем.
            { at: at('2026-08-15T10:00:00Z'), ok: true, amount: '299.00' },
          ],
        },
        {
          amount: '19.90',
          currency: 'USD',
          createdAt: new Date('2026-11-05T10:00:00Z'),
          attempts: [{ at: at('2026-11-12T10:00:00Z'), ok: true, amount: '19.90' }],
        },
      ];

      const totals = accumulateMoney({ rows, range });

      assert.equal(totals.issued, 2);
      assert.equal(totals.expectedCharges, 3);
      assert.equal(totals.succeededCharges, 2);
      assert.equal(totals.failedCharges, 1);
      assert.deepEqual(totals.byCurrency.get('RUB'), { potentialCents: 59_800, receivedCents: 29_900 });
      assert.deepEqual(totals.byCurrency.get('USD'), { potentialCents: 1_990, receivedCents: 1_990 });
    });

    it('для неуспешной попытки планирует сумму строки, для успешной — сумму из попытки', () => {
      const rows = [
        {
          amount: '300.00',
          currency: 'RUB',
          createdAt: new Date('2026-11-05T10:00:00Z'),
          attempts: [
            // Провайдер списал по старой цене — берём его слово.
            { at: at('2026-11-10T10:00:00Z'), ok: true, amount: '250.00' },
            { at: at('2026-11-15T10:00:00Z'), ok: false, error: 'FAIL' },
          ],
        },
      ];

      const totals = accumulateMoney({ rows, range });

      // 250 (получено) + 300 (планировалось к неуспешной) = 550 потенциала.
      assert.deepEqual(totals.byCurrency.get('RUB'), { potentialCents: 55_000, receivedCents: 25_000 });
      assert.equal(totals.succeededCharges, 1);
      assert.equal(totals.failedCharges, 1);
    });

    it('«за всё время» учитывает и старые попытки', () => {
      const rows = [
        {
          amount: '100.00',
          currency: 'RUB',
          createdAt: new Date('2025-01-01T10:00:00Z'),
          attempts: [{ at: at('2025-02-01T10:00:00Z'), ok: true, amount: '100.00' }],
        },
      ];
      const all = accumulateMoney({ rows, range: statsRange('all', NOW) });
      assert.equal(all.expectedCharges, 1);
      assert.equal(all.issued, 1);
      const month = accumulateMoney({ rows, range });
      assert.equal(month.expectedCharges, 0);
      assert.equal(month.issued, 0);
    });

    it('битые попытки не ломают итог', () => {
      const rows = [
        {
          amount: '100.00',
          currency: 'RUB',
          createdAt: new Date('2026-11-05T10:00:00Z'),
          attempts: [{ at: 'not a date', ok: true }, { ok: true }],
        },
      ];
      const totals = accumulateMoney({ rows, range });
      assert.equal(totals.expectedCharges, 0);
      assert.deepEqual(totals.byCurrency.get('RUB'), { potentialCents: 0, receivedCents: 0 });
    });
  });

  describe('«не состоялось»: план был, попытки не было', () => {
    const range = statsRange('30d', NOW);

    /** Строка, у которой дата списания прошла, а попыток нет. */
    const missedRow = (nextChargeAt: string, overrides: Record<string, unknown> = {}) => ({
      amount: '299.00',
      currency: 'RUB',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      attempts: [],
      nextChargeAt: new Date(nextChargeAt),
      status: 'ACTIVE',
      ...overrides,
    });

    it('считает пропуск, если дата прошла и попытки не было', () => {
      const totals = accumulateMoney({ rows: [missedRow('2026-11-10T10:00:00Z')], range });
      assert.equal(totals.missedCharges, 1);
      // В проценты это не входит: ожидаемых попыток нет.
      assert.equal(totals.expectedCharges, 0);
    });

    it('не считает, если попытка была рядом с плановой датой', () => {
      const totals = accumulateMoney({
        rows: [
          missedRow('2026-11-10T10:00:00Z', {
            attempts: [{ at: at('2026-11-12T10:00:00Z'), ok: false, error: 'ACTIVE_FAILED' }],
          }),
        ],
        range,
      });
      assert.equal(totals.missedCharges, 0);
    });

    it('даёт сутки форы свежему списанию: сегодняшнее — ещё не пропуск', () => {
      const totals = accumulateMoney({ rows: [missedRow('2026-11-21T09:00:00Z')], range });
      assert.equal(totals.missedCharges, 0);
    });

    it('будущее и отменённые строки не считает', () => {
      const future = accumulateMoney({ rows: [missedRow('2026-12-10T10:00:00Z')], range });
      assert.equal(future.missedCharges, 0);
      const cancelled = accumulateMoney({
        rows: [missedRow('2026-11-10T10:00:00Z', { status: 'CANCELLED' })],
        range,
      });
      assert.equal(cancelled.missedCharges, 0);
    });

    it('план раньше периода в периодический срез не попадает, а в «всё время» — да', () => {
      const old = missedRow('2026-06-10T10:00:00Z');
      assert.equal(accumulateMoney({ rows: [old], range }).missedCharges, 0);
      assert.equal(accumulateMoney({ rows: [old], range: statsRange('all', NOW) }).missedCharges, 1);
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
