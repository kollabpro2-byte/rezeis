import { readAutopayAttempts } from './autopay-log.util';

/**
 * Статистика автосписаний: периоды и разбивка по времени.
 *
 * Три категории, которые оператор спрашивает про автопродления:
 *
 *  • `autopayRenewed` — автопродление сработало: деньги списаны, срок продлён;
 *  • `manualSupersededLive` — клиент продлил вручную, а автопродление осталось
 *    живым (может списать ещё раз) — это то, что требует внимания;
 *  • `manualSupersededCancelled` — клиент продлил вручную, и мы погасили
 *    автопродление из-за этого.
 *
 * Логика чистая: границы периода считаются от «сейчас» и проверяются тестами,
 * без базы и без HTTP.
 */
export type AutopayStatsPeriod =
  | 'day'
  | '3d'
  | '7d'
  | '14d'
  | '30d'
  | '90d'
  | '180d'
  | '365d'
  | 'all';

/** Все периоды в том порядке, в каком их видит оператор. */
export const AUTOPAY_STATS_PERIODS: readonly AutopayStatsPeriod[] = [
  'all',
  'day',
  '3d',
  '7d',
  '14d',
  '30d',
  '90d',
  '180d',
  '365d',
];

const PERIOD_DAYS: Readonly<Record<Exclude<AutopayStatsPeriod, 'all'>, number>> = {
  day: 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
  '180d': 180,
  '365d': 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Разбирает период из запроса; мусор читается как месяц — самый частый вопрос. */
export function readStatsPeriod(value: unknown, fallback: AutopayStatsPeriod = '30d'): AutopayStatsPeriod {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (AUTOPAY_STATS_PERIODS as readonly string[]).includes(text)
    ? (text as AutopayStatsPeriod)
    : fallback;
}

/** Границы периода: `from` = null у «за всё время». */
export interface AutopayStatsRange {
  readonly period: AutopayStatsPeriod;
  readonly from: Date | null;
  readonly to: Date;
}

/** Границы периода от `now`; «за всё время» — без нижней границы. */
export function statsRange(period: AutopayStatsPeriod, now: Date = new Date()): AutopayStatsRange {
  if (period === 'all') return { period, from: null, to: now };
  const days = PERIOD_DAYS[period];
  return { period, from: new Date(now.getTime() - days * DAY_MS), to: now };
}

/**
 * Шаг разбивки: сутки до двух месяцев, неделя дальше. Мельче суток смысла нет
 * (автосписаний в час единицы), а на годе суточный график — это 365 столбиков,
 * в которых ничего не видно.
 */
export function statsBucketMs(range: AutopayStatsRange): number {
  if (range.from === null) return 7 * DAY_MS;
  const spanMs = range.to.getTime() - range.from.getTime();
  return spanMs > 62 * DAY_MS ? 7 * DAY_MS : DAY_MS;
}

/** Начало бакета, в который попадает момент (округление вниз по UTC). */
export function bucketStart(at: Date, bucketMs: number): Date {
  const size = bucketMs;
  return new Date(Math.floor(at.getTime() / size) * size);
}

/** Копейки/центы из `"299.00"`; нечисло — 0, чтобы одна кривая строка не ломала итог. */
export function toMinorUnits(amount: string): number {
  const value = Number.parseFloat(amount.replace(',', '.'));
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** Обратно в строку с двумя знаками — так суммы и уходят в API. */
export function fromMinorUnits(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Деньги и качество списаний по одному срезу: суммы в валютах и счётчики попыток. */
export interface AutopayMoneyStatsInterface {
  /** Сколько автосписаний оформлено за период. */
  readonly issued: number;
  /** Попыток списания в периоде — это и есть «ожидаемые» для процентов. */
  readonly expectedCharges: number;
  readonly succeededCharges: number;
  readonly failedCharges: number;
  /** Проценты с одним знаком: успешных и ошибок из ожидаемых. */
  readonly successRate: number;
  readonly errorRate: number;
  /** Потенциал — все ожидаемые списания; получено — успешные. По валютам. */
  readonly potential: ReadonlyArray<{ readonly currency: string; readonly amount: string }>;
  readonly received: ReadonlyArray<{ readonly currency: string; readonly amount: string }>;
}

/** Одна строка автосписания, как её видит агрегация. */
export interface AutopayMoneyRow {
  readonly amount: string;
  readonly currency: string;
  readonly createdAt: Date;
  readonly attempts: unknown;
}

/**
 * Считает деньги и качество списаний по истории попыток.
 *
 * «Ожидаемые» здесь — это попытки, которые провайдер сделал за период: каждая
 * из них была плановым списанием. Так проценты честные и симметричные:
 * `successRate + errorRate = 100` (если попытки были), и обе считаются из
 * одной базы. Суммы группируются по валютам: складывать рубли с долларами
 * нельзя, поэтому валюты идут отдельными списками.
 *
 * Сумма ожидаемого для успешной попытки берётся из неё самой (провайдер назвал
 * сумму списания), иначе — из суммы строки; для неуспешной — из суммы строки,
 * потому что денег по ней не было, а планировалась именно она.
 */
export function accumulateMoney(input: {
  readonly rows: readonly AutopayMoneyRow[];
  readonly range: AutopayStatsRange;
}): {
  readonly issued: number;
  readonly expectedCharges: number;
  readonly succeededCharges: number;
  readonly failedCharges: number;
  readonly byCurrency: ReadonlyMap<string, { readonly potentialCents: number; readonly receivedCents: number }>;
} {
  const from = input.range.from?.getTime() ?? null;
  const to = input.range.to.getTime();
  const byCurrency = new Map<string, { potentialCents: number; receivedCents: number }>();
  let issued = 0;
  let expectedCharges = 0;
  let succeededCharges = 0;
  let failedCharges = 0;

  for (const row of input.rows) {
    const created = row.createdAt.getTime();
    if ((from === null || created >= from) && created <= to) issued += 1;

    const bucket = byCurrency.get(row.currency) ?? { potentialCents: 0, receivedCents: 0 };
    for (const attempt of readAutopayAttempts(row.attempts)) {
      const at = new Date(attempt.at).getTime();
      if (!Number.isFinite(at) || at < (from ?? 0) || at > to) continue;
      expectedCharges += 1;
      const plannedCents = toMinorUnits(attempt.ok && attempt.amount !== undefined ? attempt.amount : row.amount);
      bucket.potentialCents += plannedCents;
      if (attempt.ok) {
        succeededCharges += 1;
        bucket.receivedCents += plannedCents;
      } else {
        failedCharges += 1;
      }
    }
    byCurrency.set(row.currency, bucket);
  }

  return { issued, expectedCharges, succeededCharges, failedCharges, byCurrency };
}

/** Процент с одним знаком; ноль ожидаемых — ноль процентов, а не деление на ноль. */
export function sharePercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part * 1000) / total) / 10;
}
