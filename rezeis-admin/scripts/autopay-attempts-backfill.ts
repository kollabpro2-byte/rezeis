#!/usr/bin/env node
/**
 * Автосписания: разовая догрузка истории попыток
 * ──────────────────────────────────────────────
 *
 * Колонка `attempts` появилась позже самих автосписаний, поэтому у строк,
 * созданных раньше, она пустая — оператор не видит ни успешных списаний, ни
 * провалов. Скрипт восстанавливает историю из того, что уже есть в базе:
 *
 *  • успешные — из транзакций, которые сделал сам рекуррент
 *    (`idempotency_key LIKE 'provider-subscription:%'`, статус COMPLETED);
 *  • неуспешные — у строк в `PAST_DUE`, датой `next_charge_at` и словом
 *    провайдера, если других неуспешных попыток ещё нет.
 *
 * Идемпотентность: запись идёт через `appendAutopayAttempt`, которая
 * отбрасывает повтор с той же датой и результатом. Повторный запуск ничего не
 * дублирует, поэтому скрипт можно гонять сколько угодно.
 *
 * Использование
 *   node --require ts-node/register scripts/autopay-attempts-backfill.ts           # dry-run (по умолчанию)
 *   node --require ts-node/register scripts/autopay-attempts-backfill.ts --apply   # записать
 *   ... --only <rowId,rowId>                                                       # только эти строки
 *   ... --batch <n>                                                                # размер страницы (200)
 *
 * Переменные окружения
 *   DATABASE_URL — та же база, что у панели.
 */
import { Prisma, PrismaClient, ProviderSubscriptionStatus } from '@prisma/client';

import { appendAutopayAttempt, readAutopayAttempts } from '../src/modules/payments/utils/autopay-log.util';

const prisma = new PrismaClient();

interface Options {
  readonly apply: boolean;
  readonly batch: number;
  readonly only: readonly string[];
}

function readOptions(argv: readonly string[]): Options {
  const apply = argv.includes('--apply');
  const batchIndex = argv.indexOf('--batch');
  const onlyIndex = argv.indexOf('--only');
  const batch = batchIndex === -1 ? 200 : Number.parseInt(argv[batchIndex + 1] ?? '200', 10);
  const only = onlyIndex === -1 ? [] : (argv[onlyIndex + 1] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return {
    apply,
    batch: Number.isFinite(batch) && batch > 0 && batch <= 1000 ? batch : 200,
    only,
  };
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  process.stdout.write(
    `Режим: ${options.apply ? 'ЗАПИСЬ' : 'проверка (--apply, чтобы записать)'}, страница ${options.batch}\n`,
  );

  let cursor: string | undefined;
  let scanned = 0;
  let changed = 0;
  let duplicatesSkipped = 0;

  for (;;) {
    const rows = await prisma.providerSubscription.findMany({
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
        appliedChargeCount: true,
        gatewayType: true,
        firstTransactionId: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const existing = readAutopayAttempts(row.attempts);
      let next = existing as ReturnType<typeof readAutopayAttempts>;

      // Успешные списания: транзакции этого рекуррента.
      const charges = await prisma.transaction.findMany({
        where: {
          idempotencyKey: { startsWith: 'provider-subscription:' },
          status: 'COMPLETED',
          OR: [
            { id: row.firstTransactionId },
            { idempotencyKey: { contains: `:${row.id}:` } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, amount: true },
      });
      for (const charge of charges) {
        const before = next.length;
        next = appendAutopayAttempt(next as never, {
          at: charge.createdAt.toISOString(),
          ok: true,
          amount: charge.amount.toString(),
        });
        if (next.length === before) duplicatesSkipped += 1;
      }

      // Провал: строка в PAST_DUE, а неуспешных попыток ещё нет.
      const hasFailure = next.some((attempt) => !attempt.ok);
      if (row.status === ProviderSubscriptionStatus.PAST_DUE && !hasFailure) {
        const at = (row.nextChargeAt ?? new Date()).toISOString();
        const before = next.length;
        next = appendAutopayAttempt(next as never, {
          at,
          ok: false,
          error: row.providerStatus ?? 'PAST_DUE',
        });
        if (next.length === before) duplicatesSkipped += 1;
      }

      if (next.length === existing.length) continue;
      changed += 1;
      process.stdout.write(
        `${row.id} (${row.gatewayType}): попыток ${existing.length} → ${next.length}\n`,
      );
      if (options.apply) {
        await prisma.providerSubscription.update({
          where: { id: row.id },
          data: { attempts: next as unknown as Prisma.InputJsonValue },
        });
      }
    }

    cursor = rows[rows.length - 1]?.id;
    if (rows.length < options.batch) break;
  }

  process.stdout.write(
    `\nИтого: просмотрено ${scanned}, к записи ${changed}, отброшено дублей ${duplicatesSkipped}. ` +
      `${options.apply ? 'Записано.' : 'Ничего не изменено (dry-run).'}\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Ошибка: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
