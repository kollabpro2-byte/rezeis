import {
  type AutocancelMode,
  type StaleCleanupMode,
  readAutocancelMode,
  readStaleCleanupMode,
  readStaleDays,
} from './autopay-health.util';

/**
 * Поведение автосписаний, которое оператор включает сам.
 *
 * Флаги живут в окружении, а не в таблице настроек: это деплой-конфиг, он
 * меняется вместе с образом и не требует миграции. Значения по умолчанию
 * безопасные: ничего не отменять у провайдера (`mark`) и ничего не скрывать
 * (`dry-run`).
 */
export interface AutopayFlags {
  /** Лишние строки (заменённые/продлённые вручную) в общем sweep. */
  readonly autocancelMode: AutocancelMode;
  /** То же, но сразу после ручного продления. */
  readonly autocancelOnManualRenew: AutocancelMode;
  /** Ежедневная уборка старых автосписаний. */
  readonly staleCleanupMode: StaleCleanupMode;
  /** Сколько дней считать «старым» автосписанием. */
  readonly staleDays: number;
}

/** Читает флаги из окружения; мусор в переменной даёт значение по умолчанию. */
export function readAutopayFlags(env: NodeJS.ProcessEnv = process.env): AutopayFlags {
  return {
    autocancelMode: readAutocancelMode(env['AUTOPAY_AUTOCANCEL_MODE'] ?? null),
    autocancelOnManualRenew: readAutocancelMode(env['AUTOPAY_AUTOCANCEL_ON_MANUAL_RENEW'] ?? null),
    staleCleanupMode: readStaleCleanupMode(env['AUTOPAY_STALE_CLEANUP_MODE'] ?? null),
    staleDays: readStaleDays(env['AUTOPAY_STALE_DAYS'] ?? null),
  };
}
