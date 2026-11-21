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
  /**
   * Идентификатор списания у провайдера: Antilopay `payment_id` (`APAY…`).
   * По нему оператор находит платёж в личном кабинете провайдера.
   */
  readonly paymentId?: string;
  /** Наш `payment_id` (он же `order_id` у провайдера) этого списания. */
  readonly orderId?: string;
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
    const paymentId = readText(record['paymentId']);
    const orderId = readText(record['orderId']);
    out.push({
      at,
      ok,
      ...(ok && amount !== null ? { amount } : {}),
      ...(ok ? {} : { error }),
      ...(paymentId === null ? {} : { paymentId }),
      ...(orderId === null ? {} : { orderId }),
    });
  }
  return out;
}

/**
 * Дописывает попытку и обрезает историю до {@link AUTOPAY_ATTEMPTS_CAP}.
 *
 * Дубли не пишутся: синхронизация может пройти дважды по одному списанию.
 * Ключ — идентификатор списания у провайдера, когда он есть (это точнее всего:
 * два разных списания в одну секунду — редкость, но одно и то же списание,
 * увиденное дважды, — обычное дело), иначе момент и результат.
 */
export function appendAutopayAttempt(value: unknown, entry: AutopayAttempt): AutopayAttempt[] {
  const existing = readAutopayAttempts(value);
  const duplicate = existing.some((attempt) =>
    entry.paymentId !== undefined && attempt.paymentId !== undefined
      ? attempt.paymentId === entry.paymentId
      : attempt.at === entry.at && attempt.ok === entry.ok,
  );
  if (duplicate) return existing;
  const next = [...existing, entry].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return next.length > AUTOPAY_ATTEMPTS_CAP ? next.slice(next.length - AUTOPAY_ATTEMPTS_CAP) : next;
}

/**
 * Идентификаторы всех списаний из истории: провайдера (`paymentId`) и наши
 * (`orderId`), без повторов, новее — первыми.
 *
 * Это то, что оператор копирует в карточку: по `paymentId` платёж ищется в
 * кабинете провайдера, по `orderId` — в панели.
 */
export function autopayChargeIds(value: unknown, limit = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // `readAutopayAttempts` отдаёт историю по возрастанию даты — разворачиваем,
  // чтобы в карточке и в таблице первым был самый свежий платёж.
  for (const attempt of [...readAutopayAttempts(value)].reverse()) {
    if (!attempt.ok) continue;
    if (attempt.paymentId !== undefined && !seen.has(attempt.paymentId)) {
      seen.add(attempt.paymentId);
      out.push(attempt.paymentId);
    }
    if (attempt.orderId !== undefined && !seen.has(attempt.orderId)) {
      seen.add(attempt.orderId);
      out.push(attempt.orderId);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
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
