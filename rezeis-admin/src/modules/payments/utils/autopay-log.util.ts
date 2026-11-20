/**
 * История попыток автосписания по одной подписке провайдера.
 *
 * Провайдер (Antilopay, Platega, RollyPay, AuraPay) списывает сам, и панель
 * видит только результат: успешное списание становится продлением, неуспешное —
 * `PAST_DUE`. Оператору нужно и то, и другое с датами, поэтому каждая попытка
 * дописывается в `provider_subscriptions.attempts` (JSONB), а не выводится из
 * транзакций: неуспешных транзакций не бывает, деньги не двигались.
 *
 * Список ограничен по длине: строка в базе не должна расти бесконечно.
 */
export interface AutopayAttempt {
  /** Когда провайдер сделал попытку, ISO. */
  readonly at: string;
  /** true — деньги списаны и продление выдано. */
  readonly ok: boolean;
  /** Сумма списания, как её назвал провайдер (только у успешных). */
  readonly amount?: string;
  /** Слово провайдера о неудаче (только у неуспешных). */
  readonly error?: string | null;
}

/** Сколько последних попыток храним. */
export const AUTOPAY_ATTEMPTS_CAP = 50;

/** Сводка для таблицы: сколько было успешных/неуспешных и когда последняя. */
export interface AutopayAttemptSummary {
  readonly succeeded: number;
  readonly failed: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Читает JSON-колонку, отбрасывая то, что не похоже на попытку. */
export function readAutopayAttempts(value: unknown): AutopayAttempt[] {
  if (!Array.isArray(value)) return [];
  const out: AutopayAttempt[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const at = readText(record['at']);
    if (at === null || Number.isNaN(new Date(at).getTime())) continue;
    const ok = record['ok'] === true;
    const amount = readText(record['amount']);
    const error = readText(record['error']);
    out.push({
      at,
      ok,
      ...(ok && amount !== null ? { amount } : {}),
      ...(ok ? {} : { error }),
    });
  }
  return out;
}

/**
 * Дописывает попытку и обрезает историю до {@link AUTOPAY_ATTEMPTS_CAP}.
 * Одинаковые попытки (тот же момент и результат) не дублируются: синхронизация
 * может пройти дважды по одному и тому же списанию.
 */
export function appendAutopayAttempt(value: unknown, entry: AutopayAttempt): AutopayAttempt[] {
  const existing = readAutopayAttempts(value);
  if (existing.some((attempt) => attempt.at === entry.at && attempt.ok === entry.ok)) {
    return existing;
  }
  const next = [...existing, entry].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return next.length > AUTOPAY_ATTEMPTS_CAP ? next.slice(next.length - AUTOPAY_ATTEMPTS_CAP) : next;
}

/** Сводка по истории для таблицы автосписаний. */
export function summariseAutopayAttempts(value: unknown): AutopayAttemptSummary {
  const attempts = readAutopayAttempts(value);
  let succeeded = 0;
  let failed = 0;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  for (const attempt of attempts) {
    if (attempt.ok) {
      succeeded += 1;
      if (lastSuccessAt === null || attempt.at > lastSuccessAt) lastSuccessAt = attempt.at;
    } else {
      failed += 1;
      if (lastFailureAt === null || attempt.at > lastFailureAt) lastFailureAt = attempt.at;
    }
  }
  return { succeeded, failed, lastSuccessAt, lastFailureAt };
}

/**
 * Запас после автосписания: подписка должна жить ещё столько, чтобы провайдер
 * успел списать и продление успело примениться.
 */
export const AUTOPAY_GRACE_HOURS = 6;

/**
 * Насколько заранее подписка может кончиться до списания, чтобы мы её продлили.
 * Сутки: «несколько часов» — это точно меньше, а продлевать на дни вперёд по
 * одному лишь расписанию провайдера нельзя, оно сдвигается.
 */
export const AUTOPAY_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Куда продлить подписку: момент списания плюс запас. */
export function autopayGraceDeadline(nextChargeAt: Date, hours: number = AUTOPAY_GRACE_HOURS): Date {
  return new Date(nextChargeAt.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Новый `expiresAt`, если подписка кончается раньше автосписания, или null.
 *
 * Условия: списание известно и ещё не просрочено; подписка кончается ДО него, и
 * разрыв не больше окна (иначе это не «пара часов», а сломанное расписание);
 * продление действительно даёт запас в будущем. Функция идемпотентна: после
 * продления `expiresAt` становится больше `nextChargeAt`, и условие больше не
 * выполняется — цикл не будет продлевать одно и то же каждый час.
 */
export function shouldExtendForAutopay(input: {
  readonly expiresAt: Date | null;
  readonly nextChargeAt: Date | null;
  readonly now?: Date;
  readonly windowMs?: number;
  readonly graceHours?: number;
}): Date | null {
  const { expiresAt, nextChargeAt } = input;
  if (expiresAt === null || nextChargeAt === null) return null;
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? AUTOPAY_GRACE_WINDOW_MS;
  const graceHours = input.graceHours ?? AUTOPAY_GRACE_HOURS;

  const gapMs = nextChargeAt.getTime() - expiresAt.getTime();
  // Подписка и так доживает до списания — трогать нечего.
  if (gapMs <= 0) return null;
  if (gapMs > windowMs) return null;

  const deadline = autopayGraceDeadline(nextChargeAt, graceHours);
  // Списание уже прошло, а подписка всё ещё не продлена: запас в прошлом,
  // продлевать до него бессмысленно.
  if (deadline.getTime() <= now.getTime()) return null;
  return deadline;
}
