#!/usr/bin/env node
/**
 * Автосписания: разовая догрузка истории попыток и id списаний
 * ───────────────────────────────────────────────────────────
 *
 * Колонка `attempts` появилась позже самих автосписаний, поэтому у строк,
 * созданных раньше, она пустая — оператор не видит ни успешных списаний, ни
 * провалов. Позже у попыток появились id (`paymentId` у провайдера, `orderId`
 * наш) — у старых записей их тоже нет, и найти платёж в кабинете провайдера
 * было нечем.
 *
 * Скрипт делает две вещи, обе идемпотентные:
 *
 *  1. Восстанавливает пропущенные попытки:
 *     • успешные — из транзакций, которые сделал сам рекуррент
 *       (`idempotency_key LIKE 'provider-subscription:<rowId>:%'`, COMPLETED);
 *     • неуспешные — у строк в `PAST_DUE`, датой `next_charge_at` и словом
 *       провайдера, если других неуспешных попыток ещё нет.
 *  2. Дописывает id к уже существующим попыткам, у которых их нет:
 *     • из нашей базы — ключ транзакции содержит `APAY…`
 *       (`provider-subscription:<rowId>:payment:<providerPaymentId>`), а
 *       `transactions.payment_id` — наш `order_id`;
 *     • с `--provider` — ещё и из Antilopay `payment/recurrent/check`
 *       (`payments[].payment_id`, `order_id`, `ctime`). Это авторитетный
 *       источник: там же дата, которую провайдер считает датой списания.
 *
 * Сопоставление попытки и списания: сначала по порядку (оба списка
 * хронологические и описывают одни и те же списания), затем — по ближайшей
 * дате в пределах суток, если количество не совпало. Ничего не выдумывается:
 * попытка без пары остаётся без id, и скрипт пишет об этом.
 *
 * Приватные ключи Antilopay берутся из `payment_gateways.settings` — тех же,
 * что читает панель; ничего в переменные окружения выносить не нужно.
 *
 * Использование
 *   node --require ts-node/register scripts/autopay-attempts-backfill.ts             # dry-run (по умолчанию)
 *   node --require ts-node/register scripts/autopay-attempts-backfill.ts --apply     # записать
 *   ... --provider                                                                   # + запросить Antilopay
 *   ... --only <rowId,rowId>                                                         # только эти строки
 *   ... --batch <n>                                                                  # размер страницы (200)
 *
 * Переменные окружения
 *   DATABASE_URL — та же база, что у панели.
 */
import { HttpService } from '@nestjs/axios';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, ProviderSubscriptionStatus } from '@prisma/client';
import axios from 'axios';
import { from } from 'rxjs';

import { postAntilopay } from '../src/modules/payments/utils/antilopay-api.util';
import {
  appendAutopayAttempt,
  readAutopayAttempts,
  type AutopayAttempt,
} from '../src/modules/payments/utils/autopay-log.util';
import { parseAntilopayRecurrent } from '../src/modules/payments/utils/antilopay-recurrent.util';

/**
 * Prisma 7 требует драйвер-адаптер: `new PrismaClient()` без него бросает
 * исключение ещё при создании. Клиент ленивый — спека импортирует чистые
 * функции (`enrichAttempts`) и не должна ни подключаться к базе, ни читать env.
 */
let client: PrismaClient | null = null;

function db(): PrismaClient {
  client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }),
  });
  return client;
}

/** Как `PrismaService`: явный `DATABASE_URL`, иначе части по отдельности. */
function resolveDatabaseUrl(): string {
  const explicit = process.env['DATABASE_URL'];
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;
  const host = process.env['DATABASE_HOST'] ?? 'localhost';
  const port = process.env['DATABASE_PORT'] ?? '5432';
  const name = process.env['DATABASE_NAME'] ?? 'rezeis';
  const user = process.env['DATABASE_USER'] ?? 'rezeis';
  const password = encodeURIComponent(process.env['DATABASE_PASSWORD'] ?? '');
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

/** `postAntilopay` ждёт `HttpService`; обёртка вокруг axios даёт тот же контракт. */
const httpService = {
  post: (url: string, body: string, config: Record<string, unknown>) => from(axios.post(url, body, config)),
} as unknown as HttpService;

/** Одно списание, как его видно из базы или из ответа провайдера. */
export interface ChargeIds {
  readonly paymentId: string | null;
  readonly orderId: string | null;
  readonly at: Date | null;
}

interface Options {
  readonly apply: boolean;
  readonly batch: number;
  readonly only: readonly string[];
  /** Спрашивать Antilopay о `payments[]` — иначе только наша база. */
  readonly provider: boolean;
}

function readOptions(argv: readonly string[]): Options {
  const apply = argv.includes('--apply');
  const provider = argv.includes('--provider');
  const batchIndex = argv.indexOf('--batch');
  const onlyIndex = argv.indexOf('--only');
  const batch = batchIndex === -1 ? 200 : Number.parseInt(argv[batchIndex + 1] ?? '200', 10);
  const only = onlyIndex === -1 ? [] : (argv[onlyIndex + 1] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return {
    apply,
    provider,
    batch: Number.isFinite(batch) && batch > 0 && batch <= 1000 ? batch : 200,
    only,
  };
}

/** Списания строки, которые видно в нашей базе: ключ транзакции несёт `APAY…`. */
async function chargesFromDb(rowId: string, firstTransactionId: string): Promise<ChargeIds[]> {
  const transactions = await db().transaction.findMany({
    where: {
      status: 'COMPLETED',
      OR: [
        { id: firstTransactionId },
        { idempotencyKey: { contains: `:${rowId}:` } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, paymentId: true, idempotencyKey: true },
  });
  return transactions.map((transaction) => {
    const key = transaction.idempotencyKey ?? '';
    // `provider-subscription:<rowId>:payment:<providerPaymentId>` — у Antilopay;
    // `…:charge:<n>` — у провайдеров, которые считают списания номером.
    const tail = /:payment:(.+)$/.exec(key)?.[1] ?? null;
    return { paymentId: tail, orderId: transaction.paymentId, at: transaction.createdAt };
  });
}

/** Списания строки по слову провайдера: `payment/recurrent/check` → `payments[]`. */
async function chargesFromProvider(row: {
  readonly providerRecurrentId: string | null;
}): Promise<ChargeIds[]> {
  const recurrentId = row.providerRecurrentId;
  if (recurrentId === null) return [];
  const gateway = await db().paymentGateway.findUnique({ where: { type: 'ANTILOPAY' } });
  if (gateway === null) return [];
  const reply = await postAntilopay(
    httpService,
    gateway.settings as Record<string, unknown>,
    'payment/recurrent/check',
    { recurrent_id: recurrentId },
  );
  if (reply.code !== 0) {
    process.stderr.write(`  Antilopay check ${recurrentId}: код ${reply.code}, пропускаю\n`);
    return [];
  }
  return parseAntilopayRecurrent(reply.data).charges.map((charge) => ({
    paymentId: charge.id,
    orderId: charge.orderId,
    at: charge.at,
  }));
}

/** Насколько может разойтись наша дата и дата провайдера при поиске пары. */
export const PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ближайшее по времени списание в пределах окна, ещё не занятое другой попыткой. */
function nearestCharge(
  attempt: AutopayAttempt,
  pool: readonly ChargeIds[],
  used: ReadonlySet<number>,
): ChargeIds | undefined {
  const at = new Date(attempt.at).getTime();
  if (!Number.isFinite(at)) return undefined;
  let best: { charge: ChargeIds; distance: number } | undefined;
  for (const [index, charge] of pool.entries()) {
    if (used.has(index) || charge.at === null) continue;
    const distance = Math.abs(charge.at.getTime() - at);
    if (distance > PAIR_WINDOW_MS) continue;
    if (best === undefined || distance < best.distance) best = { charge, distance };
  }
  return best?.charge;
}

/**
 * Дописывает id к успешным попыткам, у которых их нет.
 *
 * Попытки и списания — оба списка хронологические и описывают одни и те же
 * деньги, поэтому при равном количестве пары идут по порядку. Если количество
 * разошлось (часть списаний не доставлена, история обрезана лимитом), ищем
 * ближайшее по времени списание в пределах суток. Не нашли — попытка остаётся
 * без id: выдумать чужой платёж хуже, чем не иметь никакого.
 */
export function enrichAttempts(
  attempts: readonly AutopayAttempt[],
  charges: readonly ChargeIds[],
): { readonly next: AutopayAttempt[]; readonly filled: number; readonly unmatched: number } {
  const successes = attempts.map((attempt, index) => ({ attempt, index })).filter((entry) => entry.attempt.ok);
  const pool = charges
    .filter((charge) => charge.paymentId !== null || charge.orderId !== null)
    .sort((left, right) => (left.at?.getTime() ?? 0) - (right.at?.getTime() ?? 0));

  const used = new Set<number>();
  const assign = new Map<number, ChargeIds>();
  const byOrder = pool.length === successes.length;

  for (const [position, entry] of successes.entries()) {
    const charge = byOrder ? pool[position] : nearestCharge(entry.attempt, pool, used);
    if (charge === undefined) continue;
    used.add(pool.indexOf(charge));
    assign.set(entry.index, charge);
  }

  let filled = 0;
  let unmatched = 0;
  const next = attempts.map((attempt, index) => {
    const charge = assign.get(index);
    if (charge === undefined) {
      if (attempt.ok && attempt.paymentId === undefined && attempt.orderId === undefined) unmatched += 1;
      return attempt;
    }
    const paymentId = attempt.paymentId ?? charge.paymentId ?? undefined;
    const orderId = attempt.orderId ?? charge.orderId ?? undefined;
    if (paymentId === attempt.paymentId && orderId === attempt.orderId) return attempt;
    filled += 1;
    return {
      ...attempt,
      ...(paymentId === undefined ? {} : { paymentId }),
      ...(orderId === undefined ? {} : { orderId }),
    };
  });
  return { next, filled, unmatched };
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  process.stdout.write(
    `Режим: ${options.apply ? 'ЗАПИСЬ' : 'проверка (--apply, чтобы записать)'}, ` +
      `страница ${options.batch}, провайдер ${options.provider ? 'спрашиваем' : 'не спрашиваем (--provider)'}\n`,
  );

  let cursor: string | undefined;
  let scanned = 0;
  let changed = 0;
  let duplicatesSkipped = 0;
  let idsFilled = 0;
  let idsUnmatched = 0;

  for (;;) {
    const rows = await db().providerSubscription.findMany({
      where: options.only.length === 0 ? {} : { id: { in: [...options.only] } },
      orderBy: { id: 'asc' },
      take: options.batch,
      ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
      select: {
        id: true,
        status: true,
        providerStatus: true,
        nextChargeAt: true,
        attempts: true,
        gatewayType: true,
        firstTransactionId: true,
        providerRecurrentId: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const existing = readAutopayAttempts(row.attempts);
      let next: AutopayAttempt[] = [...existing];

      // 1. Списания, которые видно у нас: из них и попытки, и id.
      const charges = await chargesFromDb(row.id, row.firstTransactionId);
      for (const charge of charges) {
        const before = next.length;
        next = appendAutopayAttempt(next, {
          at: (charge.at ?? new Date()).toISOString(),
          ok: true,
          // Сумму отсюда не берём: `attempts` хранит сумму по слову провайдера,
          // а в транзакции она уже с комиссией площадки.
          ...(charge.paymentId === null ? {} : { paymentId: charge.paymentId }),
          ...(charge.orderId === null ? {} : { orderId: charge.orderId }),
        });
        if (next.length === before) duplicatesSkipped += 1;
      }

      // 2. Провал: строка в PAST_DUE, а неуспешных попыток ещё нет.
      const hasFailure = next.some((attempt) => !attempt.ok);
      if (row.status === ProviderSubscriptionStatus.PAST_DUE && !hasFailure) {
        const before = next.length;
        next = appendAutopayAttempt(next, {
          at: (row.nextChargeAt ?? new Date()).toISOString(),
          ok: false,
          error: row.providerStatus ?? 'PAST_DUE',
        });
        if (next.length === before) duplicatesSkipped += 1;
      }

      // 3. Id для попыток, у которых их нет: сначала база, потом провайдер.
      let source = charges;
      const needsIds = next.some((attempt) => attempt.ok && attempt.paymentId === undefined);
      if (needsIds && options.provider && row.gatewayType === 'ANTILOPAY') {
        const fromProvider = await chargesFromProvider(row);
        if (fromProvider.length > 0) source = [...charges, ...fromProvider];
      }
      const enriched = enrichAttempts(next, source);
      next = enriched.next;
      idsFilled += enriched.filled;
      idsUnmatched += enriched.unmatched;

      const grew = next.length > existing.length;
      const gotIds = enriched.filled > 0;
      if (!grew && !gotIds) continue;

      changed += 1;
      process.stdout.write(
        `${row.id} (${row.gatewayType}): попыток ${existing.length} → ${next.length}` +
          `${gotIds ? `, id дописаны у ${enriched.filled}` : ''}` +
          `${enriched.unmatched > 0 ? `, без пары ${enriched.unmatched}` : ''}\n`,
      );
      if (options.apply) {
        await db().providerSubscription.update({
          where: { id: row.id },
          data: { attempts: next as unknown as Prisma.InputJsonValue },
        });
      }
    }

    cursor = rows[rows.length - 1]?.id;
    if (rows.length < options.batch) break;
  }

  process.stdout.write(
    `\nИтого: просмотрено ${scanned}, к записи ${changed}, отброшено дублей ${duplicatesSkipped}, ` +
      `id дописаны у ${idsFilled} попыток${idsUnmatched > 0 ? `, без пары осталось ${idsUnmatched}` : ''}. ` +
      `${options.apply ? 'Записано.' : 'Ничего не изменено (dry-run).'}\n`,
  );
  if (idsUnmatched > 0) {
    process.stdout.write(
      'Попытки без пары — это либо списания, которых нет ни в базе, ни у провайдера, либо история, ' +
        'обрезанная лимитом в 50 попыток. Если ещё не запускали с --provider, попробуйте с ним.\n',
    );
  }
}

// Скрипт запускает себя только при прямом вызове: спека импортирует его чистые
// функции и не должна ни подключаться к базе, ни ходить к провайдеру.
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`Ошибка: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (client !== null) await client.$disconnect();
    });
}
