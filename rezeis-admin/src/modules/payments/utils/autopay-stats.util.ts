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
  /**
   * Плановые списания, по которым провайдер не сделал ни одной попытки: дата
   * списания прошла, а результата нет. В проценты не входят — это не неудача
   * оплаты, а её отсутствие.
   */
  readonly missedCharges: number;
  /** Проценты с одним знаком: успешных и ошибок из ожидаемых. */
  readonly successRate: number;
  readonly errorRate: number;
  /** Потенциал — все ожидаемые списания; получено — успешные. По валютам. */
  readonly potential: ReadonlyArray<{ readonly currency: string; readonly amount: string }>;
  readonly received: ReadonlyArray<{ readonly currency: string; readonly amount: string }>;
  /**
   * С какой даты панель сохраняет неуспешные попытки (раньше — не сохраняла).
   * Нужна интерфейсу, чтобы честно подписать «потенциал» как минимум.
   * `null` — неуспешных попыток в базе нет вовсе.
   */
  readonly attemptsSince: string | null;
}

/** Одна строка автосписания, как её видит агрегация. */
export interface AutopayMoneyRow {
  readonly amount: string;
  readonly currency: string;
  readonly createdAt: Date;
  readonly attempts: unknown;
  /** Планируемая дата следующего списания — по ней ищем «не состоялось». */
  readonly nextChargeAt?: Date | null;
  /** Наш статус: «не состоялось» считается только по живым строкам. */
  readonly status?: string;
}

/** Успешное автосписание из платежей: деньги получены, срок продлён. */
export interface AutopaySuccessfulCharge {
  readonly at: Date;
  readonly amount: string;
  readonly currency: string;
}

/** Свежее плановое списание ещё может пройти: сутки форы, прежде чем звать его пропуском. */
export const MISSED_CHARGE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Насколько попытка может разойтись с плановой датой и всё равно считаться «была». */
export const MISSED_CHARGE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Считает деньги и качество списаний.
 *
 * Успешные списания приходят из ПЛАТЕЖЕЙ (`successfulCharges`), а не из
 * истории попыток: колонка `attempts` появилась 20.11.2026, деньги же получены
 * с первого автосписания. Из попыток берём только неуспешные: успешные там —
 * дубль платежа, и считать их значило бы задвоить и счётчик, и сумму (владелец,
 * 22.11.2026: «Получено» 900 ₽ против 8 012 ₽ в транзакциях).
 *
 * «Ожидаемые» поэтому = успешные платежи + известные неуспешные попытки:
 * проценты остаются симметричными (`successRate + errorRate = 100`), но
 * «потенциал» — это минимум, ведь провалы до 20.11 не сохранялись. Дату, с
 * которой они есть, возвращаем как `attemptsSince`, чтобы интерфейс сказал
 * это честно, а не выдавал неполную историю за полную.
 *
 * Суммы группируются по валютам: складывать рубли с долларами нельзя, поэтому
 * валюты идут отдельными списками.
 */
export function accumulateMoney(input: {
  readonly rows: readonly AutopayMoneyRow[];
  readonly range: AutopayStatsRange;
  /** Успешные автосписания из транзакций: дата, сумма и валюта платежа. */
  readonly successfulCharges: readonly AutopaySuccessfulCharge[];
}): {
  readonly issued: number;
  readonly expectedCharges: number;
  readonly succeededCharges: number;
  readonly failedCharges: number;
  readonly missedCharges: number;
  /** Самая ранняя сохранённая неуспешная попытка: с неё история и считается. */
  readonly attemptsSince: Date | null;
  readonly byCurrency: ReadonlyMap<string, { readonly potentialCents: number; readonly receivedCents: number }>;
} {
  const from = input.range.from?.getTime() ?? null;
  const to = input.range.to.getTime();
  const byCurrency = new Map<string, { potentialCents: number; receivedCents: number }>();
  let issued = 0;
  let expectedCharges = 0;
  let succeededCharges = 0;
  let failedCharges = 0;
  let missedCharges = 0;
  let attemptsSince: Date | null = null;

  // Успех — факт платежа: и счётчик, и суммы берутся из одного источника.
  for (const charge of input.successfulCharges) {
    const at = charge.at.getTime();
    if (!Number.isFinite(at) || at < (from ?? 0) || at > to) continue;
    expectedCharges += 1;
    succeededCharges += 1;
    const bucket = byCurrency.get(charge.currency) ?? { potentialCents: 0, receivedCents: 0 };
    const cents = toMinorUnits(charge.amount);
    bucket.potentialCents += cents;
    bucket.receivedCents += cents;
    byCurrency.set(charge.currency, bucket);
  }

  for (const row of input.rows) {
    const created = row.createdAt.getTime();
    if ((from === null || created >= from) && created <= to) issued += 1;

    const attempts = readAutopayAttempts(row.attempts);
    const bucket = byCurrency.get(row.currency) ?? { potentialCents: 0, receivedCents: 0 };
    for (const attempt of attempts) {
      const at = new Date(attempt.at);
      const atMs = at.getTime();
      if (!Number.isFinite(atMs)) continue;
      // Успешные попытки уже посчитаны платежом — здесь только провалы.
      if (attempt.ok) continue;
      if (attemptsSince === null || atMs < attemptsSince.getTime()) attemptsSince = at;
      if (atMs < (from ?? 0) || atMs > to) continue;
      expectedCharges += 1;
      failedCharges += 1;
      bucket.potentialCents += toMinorUnits(row.amount);
    }
    byCurrency.set(row.currency, bucket);

    // «Не состоялось»: дата списания прошла, а попытки по ней не было вовсе.
    // Считаем только живые строки — у отменённых списаний уже не планируется.
    if (row.status !== 'ACTIVE' && row.status !== 'PAST_DUE') continue;
    const planned = row.nextChargeAt ?? null;
    if (planned === null) continue;
    const plannedAt = planned.getTime();
    if (!Number.isFinite(plannedAt)) continue;
    // Свежее списание ещё может пройти, а давнее — уже вне периода.
    if (plannedAt > to - MISSED_CHARGE_GRACE_MS) continue;
    if (from !== null && plannedAt < from) continue;
    const attempted = attempts.some((attempt) => {
      const at = new Date(attempt.at).getTime();
      return Number.isFinite(at) && Math.abs(at - plannedAt) <= MISSED_CHARGE_WINDOW_MS;
    });
    if (!attempted) missedCharges += 1;
  }

  return { issued, expectedCharges, succeededCharges, failedCharges, missedCharges, attemptsSince, byCurrency };
}

/** Процент с одним знаком; ноль ожидаемых — ноль процентов, а не деление на ноль. */
export function sharePercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part * 1000) / total) / 10;
}
