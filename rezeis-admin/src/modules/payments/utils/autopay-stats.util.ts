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
