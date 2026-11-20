import { ProviderSubscriptionStatus } from '@prisma/client';

/**
 * Здоровье автоподписки — то, что оператор должен видеть вместо «ACTIVE».
 *
 * Наш статус и статус провайдера расходятся: Antilopay держит рекуррент в
 * `PROCESSING` (или `ACTIVE_FAILED`), не двигает `next_payment_date`, а панель
 * показывала «ACTIVE» — и «следующее списание» стояло в прошлом месяце.
 */
export type AutopayHealth = 'OK' | 'STALLED' | 'PAST_DUE' | 'DESYNC';

/** Через сколько «дата списания в прошлом» становится зависанием, а не лагом. */
export const STALLED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Статусы провайдера, при которых дата в прошлом означает «завис». */
const PROVIDER_STALLED_STATUSES = new Set(['PROCESSING', 'ACTIVE_FAILED']);

/**
 * `PAST_DUE` — провайдер сказал, что списать не смог; `STALLED` — статус
 * провайдера не даёт ему двигать дату, и она уже в прошлом больше суток;
 * `DESYNC` — наш ACTIVE, но дата списания прошла (ждём синхронизации);
 * `OK` — всё на месте.
 */
export function autopayHealth(input: {
  readonly status: ProviderSubscriptionStatus;
  readonly providerStatus: string | null;
  readonly nextChargeAt: Date | null;
  readonly now?: Date;
  readonly stalledAfterMs?: number;
}): AutopayHealth {
  const now = input.now ?? new Date();
  const threshold = (input.stalledAfterMs ?? STALLED_AFTER_MS);
  const providerStatus = (input.providerStatus ?? '').toUpperCase();
  const overdue = input.nextChargeAt !== null && now.getTime() - input.nextChargeAt.getTime() > threshold;

  if (
    overdue &&
    PROVIDER_STALLED_STATUSES.has(providerStatus) &&
    (input.status === ProviderSubscriptionStatus.ACTIVE ||
      input.status === ProviderSubscriptionStatus.PAST_DUE)
  ) {
    return 'STALLED';
  }
  if (input.status === ProviderSubscriptionStatus.PAST_DUE) return 'PAST_DUE';
  if (
    input.status === ProviderSubscriptionStatus.ACTIVE &&
    input.nextChargeAt !== null &&
    input.nextChargeAt.getTime() < now.getTime()
  ) {
    return 'DESYNC';
  }
  return 'OK';
}

/** Считается ли строка зависшей по этому же правилу — для grace и sweep. */
export function isStalledAutopay(input: {
  readonly status: ProviderSubscriptionStatus;
  readonly providerStatus: string | null;
  readonly nextChargeAt: Date | null;
  readonly now?: Date;
}): boolean {
  return autopayHealth(input) === 'STALLED';
}

/**
 * Паузы между попытками отменить у провайдера: 10 мин → 30 мин → 2 ч → 6 ч →
 * 24 ч, дальше потолок. `attempts` — сколько попыток уже сделано.
 *
 * Нужно затем, чтобы `PROCESSING`-строку не долбили каждые 10 минут: провайдер
 * такую отмену всё равно не выполняет, а в логе появляется запись раз в десять
 * минут на каждую строку.
 */
export const CANCEL_BACKOFF_MS: readonly number[] = [
  10 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

/** Через сколько повторить отмену после `attempts` неудач. */
export function cancelBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 0), CANCEL_BACKOFF_MS.length - 1);
  return CANCEL_BACKOFF_MS[index] ?? 24 * 60 * 60 * 1000;
}

/** После скольких неудач оператор получает карточку «отмените вручную». */
export const CANCEL_ALERT_AFTER_ATTEMPTS = 3;

/** Режим автоматической отмены: ничего / только пометить / отменить у провайдера. */
export type AutocancelMode = 'off' | 'mark' | 'cancel';

export const AUTOPAY_AUTOCANCEL_MODE_SETTING = 'autopayAutocancelMode';
export const AUTOPAY_AUTOCANCEL_ON_MANUAL_RENEW_SETTING = 'autopayAutocancelOnManualRenew';

/** Разбирает режим из настроек; всё непонятное читается как `mark`. */
export function readAutocancelMode(value: unknown, fallback: AutocancelMode = 'mark'): AutocancelMode {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'off' || text === 'mark' || text === 'cancel' ? text : fallback;
}

/** Режим ежедневной уборки старых автосписаний. */
export type StaleCleanupMode = 'off' | 'dry-run' | 'apply';

export const AUTOPAY_STALE_CLEANUP_MODE_SETTING = 'autopayStaleCleanupMode';
export const AUTOPAY_STALE_DAYS_SETTING = 'autopayStaleDays';

/** Порог «старое автосписание»: дата списания дальше этого срока в прошлом. */
export const DEFAULT_STALE_DAYS = 6;

/** Разбирает режим уборки; всё непонятное читается как `dry-run` — он безопасный. */
export function readStaleCleanupMode(value: unknown, fallback: StaleCleanupMode = 'dry-run'): StaleCleanupMode {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'off' || text === 'dry-run' || text === 'apply' ? text : fallback;
}

/** Сколько дней из настройки; мусор и отрицательные значения — дефолт. */
export function readStaleDays(value: unknown, fallback: number = DEFAULT_STALE_DAYS): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? Math.floor(parsed) : fallback;
}

/** Причина скрытия для ежедневной уборки. */
export const HIDDEN_REASON_STALE = 'stale_autopay';

/** Причина «лишней» строки: на подписке появилась более новая живая автоподписка. */
export const SUPERSEDED_BY_NEWER_AUTOPAY = 'superseded: newer live autopay for the same subscription';

/** Причина «лишней» строки: подписку продлили ручной оплатой, а не этим рекуррентом. */
export function supersededByManualPayment(transactionId: string): string {
  return `superseded: renewed by manual payment ${transactionId}`;
}

/**
 * Отменяет ли провайдер рекуррент в этом статусе.
 *
 * Antilopay принимает `payment/recurrent/cancel` для ACTIVE и ACTIVE_FAILED, а
 * PROCESSING оставляет как есть: запрос проходит, но повторный `check` отдаёт
 * PROCESSING, и строка висит. Значит для PROCESSING нет смысла дёргать API в
 * цикле — нужна карточка оператору и ручная отмена в ЛК.
 */
export function providerCancelSupported(providerStatus: string | null): boolean {
  const text = (providerStatus ?? '').trim().toUpperCase();
  return text === 'ACTIVE' || text === 'ACTIVE_FAILED';
}

/** Строка ждёт ручной отмены в ЛК провайдера. */
export function needsManualProviderCancel(providerStatus: string | null): boolean {
  return (providerStatus ?? '').trim().toUpperCase() === 'PROCESSING';
}

