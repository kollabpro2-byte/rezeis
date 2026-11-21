import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { PaymentGatewayType, ProviderSubscription, ProviderSubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { type AutopayRefundOutcome, UNKNOWN_AUTOPAY_GATEWAY } from '../utils/refund-autopay.util';
import {
  type AutopayAttempt,
  type AutopayAttemptSummary,
  autopayChargeIds,
  readAutopayAttempts,
  summariseAutopayAttempts,
} from '../utils/autopay-log.util';
import { type AutopayHealth, autopayHealth, STALLED_AFTER_MS } from '../utils/autopay-health.util';
import { AFTER_RESPONSE_SHUTDOWN_WAIT_MS } from './payment-reconciliation.service';
import { OperatorProviderSubscriptionInterface, ProviderSubscriptionService } from './provider-subscription.service';
import { SavedPaymentMethodService, SwitchedOffMethod } from './saved-payment-method.service';

/** A saved ЮKassa method as the user's card in the panel shows it. */
export interface AdminYookassaMethodInterface {
  readonly id: string;
  readonly title: string;
  readonly methodType: string;
  readonly cardLast4: string | null;
  readonly autopayEnabled: boolean;
}

/** The customer's autopays, for the user's card in the panel. */
export interface AdminUserAutopayInterface {
  /** Platega and RollyPay subscriptions the provider charges on its own schedule, live ones. */
  readonly providerSubscriptions: readonly OperatorProviderSubscriptionInterface[];
  /** The customer's active ЮKassa methods; the panel charges them itself where `autopayEnabled`. */
  readonly yookassaMethods: readonly AdminYookassaMethodInterface[];
}

/** What «Отменить автосписание» did, as the operator's answer says it. */
export interface AdminProviderAutopayCancelResultInterface {
  /**
   * `CANCELLING` — marked, and the provider is asked after this answer;
   * `ENDED` — it was not live any more; `REFUND_ENDING` — a refund is already
   * cancelling it.
   */
  readonly state: 'CANCELLING' | 'ENDED' | 'REFUND_ENDING';
}

/** What «Выключить автосписание ЮKassa» did. */
export interface AdminYookassaAutopayDisableResultInterface {
  /** Switched off in the request. */
  readonly switched: number;
  /** Held by a charge being submitted: switched off after the answer, when that charge ends. */
  readonly pending: number;
}

/** One row of the panel's «Автосписания» table. */
export interface AdminAutopayRowInterface {
  readonly providerSubscriptionRowId: string;
  readonly userId: string | null;
  /** Логин клиента: username, им оперирует поддержка. */
  readonly login: string | null;
  readonly email: string | null;
  readonly telegramId: string | null;
  readonly gatewayType: PaymentGatewayType;
  /** CARD или SBP (Antilopay различает); null у шлюзов без выбора метода. */
  readonly method: string | null;
  readonly status: ProviderSubscriptionStatus;
  /** Слово провайдера: ACTIVE, PROCESSING, ACTIVE_FAILED, CANCEL, … */
  readonly providerStatus: string | null;
  /** Здоровье: OK / STALLED / PAST_DUE / DESYNC — то, что видит оператор. */
  readonly health: AutopayHealth;
  /** Когда автосписание подключено (подписка подписана). */
  readonly connectedAt: string;
  /** Когда провайдер спишет в следующий раз. */
  readonly nextChargeAt: string | null;
  readonly lastChargeAt: string | null;
  /** Когда панель последний раз сверяла строку с провайдером. */
  readonly lastSyncedAt: string | null;
  /** Когда кончается VPN-подписка, которую эти списания продлевают. */
  readonly expiresAt: string | null;
  /** Сколько успешных и неуспешных попыток было, и даты последних. */
  readonly attempts: AutopayAttemptSummary;
  /** Последние попытки, новее в конце: дата и время видны оператору. */
  readonly history: readonly AutopayAttempt[];
  /** Id всех успешных списаний (провайдер + наши), новее первыми. */
  readonly chargeIds: readonly string[];
  readonly amount: string;
  readonly currency: string;
  readonly planId: string;
  /** Списано рекуррентом / сколько списаний планирует провайдер. */
  readonly appliedChargeCount: number;
  readonly plannedChargeCount: number | null;
  /** Когда провайдер планирует закончить серию списаний. */
  readonly endsAt: string | null;
  /** С какого момента строка считается зависшей (если считается). */
  readonly stalledSince: string | null;
  /** Почему строка лишняя (заменена / продлена вручную) — по режиму `mark`. */
  readonly strandedReason: string | null;
  readonly strandedAt: string | null;
  /** Попытки отменить у провайдера и последняя ошибка. */
  readonly cancelAttempts: number;
  readonly cancelNextTryAt: string | null;
  readonly cancelLastError: string | null;
  /** Провайдер не отменяет сам — оператору нужно сделать это в ЛК Antilopay. */
  readonly manualCancelRequired: boolean;
  /** `recurrent_id` Antilopay: по нему строку ищут в личном кабинете. */
  readonly providerRecurrentId: string | null;
  /** Другие живые строки той же подписки — «дубль» в таблице. */
  readonly duplicateRowIds: readonly string[];
  /** Чем продлена подписка в последний раз: автосписание или ручная оплата. */
  readonly lastRenewal: {
    readonly transactionId: string;
    readonly at: string;
    readonly gatewayType: PaymentGatewayType;
    readonly purchaseType: string;
    /** true — продлил сам рекуррент, false — клиент заплатил вручную. */
    readonly isAutopay: boolean;
  } | null;
  /** Скрыта ежедневной уборкой (видна только в аудите). */
  readonly hiddenAt: string | null;
  readonly hiddenReason: string | null;
}

/** Сводка вкладки: статусы, здоровье и ожидаемые списания. */
export interface AdminAutopaySummaryInterface {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byHealth: Readonly<Record<string, number>>;
  readonly stalled: number;
  readonly expected: ReadonlyArray<{
    readonly currency: string;
    readonly in7d: string;
    readonly in30d: string;
  }>;
}

/** Ответ таблицы: страница и общее число строк под фильтром. */
export interface AdminAutopayListInterface {
  readonly items: readonly AdminAutopayRowInterface[];
  readonly total: number;
  readonly take: number;
  readonly skip: number;
}

/** Сколько последних попыток показываем в строке таблицы. */
const HISTORY_IN_ROW = 10;

/** Сколько id списаний отдаём в строке: их копируют целиком. */
const CHARGE_IDS_IN_ROW = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Начало суток: «списание сегодня» считается по календарю, а не по 24 часам. */
function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Одна ячейка CSV: кавычки и переводы строк экранируются по RFC 4180. */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The operator's «Отменить автосписание» on the user's card in the panel,
 * without a refund: a Platega or RollyPay subscription cancelled at the
 * provider, or the ЮKassa autopay switched off on every saved method.
 *
 * The answer never waits on a provider. A provider subscription is marked in
 * the request (`OPERATOR_CANCELLED_BY`), so the sweep finishes a cancel the
 * provider does not take, and the provider is asked after the answer. A
 * ЮKassa method a charge is being submitted with is switched off after the
 * answer too, when that charge lets go of it.
 *
 * Told to the operator by an operator-only card
 * (`payment.autopay_stopped_by_operator`), after the provider said what it
 * did, and written to the audit log. The customer is told nothing: the
 * customer's own switch raises `payment.method_autopay_updated`, and a letter
 * or a rule bound to it would say the customer did it. In the cabinet
 * («Способы оплаты») a cancelled provider autopay is gone from the list, and a
 * ЮKassa method shows its «Автосписание» switch off, the customer's to turn
 * back on.
 */
@Injectable()
export class AdminAutopayService implements OnModuleDestroy {
  private readonly logger = new Logger(AdminAutopayService.name);
  /** The work after an answer, each with what its card says if the panel stops first. */
  private readonly underWay = new Map<Promise<void>, { readonly label: string; readonly interrupted: () => void }>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly providerSubscriptions: ProviderSubscriptionService,
    private readonly savedPaymentMethods: SavedPaymentMethodService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  public async listForUser(userId: string): Promise<AdminUserAutopayInterface> {
    await this.requireUser(userId);
    const [providerSubscriptions, saved] = await Promise.all([
      this.providerSubscriptions.listForOperator(userId),
      this.savedPaymentMethods.listActiveForUser(userId),
    ]);
    return {
      providerSubscriptions,
      yookassaMethods: saved.methods
        .filter((method) => method.gatewayType === PaymentGatewayType.YOOKASSA)
        .map((method) => ({
          id: method.id,
          title: method.title,
          methodType: method.methodType,
          cardLast4: method.cardLast4,
          autopayEnabled: method.autopayEnabled,
        })),
    };
  }

  /**
   * Таблица «Автосписания»: живые автосписания всех клиентов, с историей
   * попыток. Один запрос страницы и один счётчик под теми же фильтрами.
   *
   * По умолчанию показываем живые: `PENDING` (клиент ещё не подтвердил),
   * `ACTIVE` и `PAST_DUE` (провайдер не смог списать и повторит). Отменённые и
   * несостоявшиеся — по явному фильтру, иначе таблица заполнится мусором.
   */
  public async listAll(query: {
    readonly search?: string;
    readonly status?: ProviderSubscriptionStatus;
    /** Статусы через запятую; важнее одиночного `status`. */
    readonly statuses?: string;
    /** Добавить завершённые (`CANCELLED`) и несостоявшиеся (`FAILED`). */
    readonly includeEnded?: boolean;
    /** Шлюз: ANTILOPAY, PLATEGA, … */
    readonly gateway?: PaymentGatewayType;
    /** Метод провайдера: CARD или SBP. */
    readonly method?: string;
    /** Здоровье: OK / STALLED / PAST_DUE / DESYNC. */
    readonly health?: string;
    /** Только дубли: больше одной живой строки на подписку. */
    readonly duplicatesOnly?: boolean;
    /** Списание в ближайшие N дней; 0 — сегодня. */
    readonly dueInDays?: number;
    /** PAST_DUE, но VPN-подписка ещё активна. */
    readonly pastDueWithActive?: boolean;
    /** Есть неуспешные попытки списания. */
    readonly failedAttemptsOnly?: boolean;
    /** Помечены как лишние (`stranded_reason` заполнен). */
    readonly strandedOnly?: boolean;
    /** Показать скрытые уборкой строки (аудит). */
    readonly includeHidden?: boolean;
    /** Только скрытые уборкой строки. */
    readonly hiddenOnly?: boolean;
    readonly take?: number;
    readonly skip?: number;
    /** Момент для health: подменяется в тестах. */
    readonly now?: Date;
  }): Promise<AdminAutopayListInterface> {
    const take = Math.min(Math.max(query.take ?? 50, 1), 200);
    const skip = Math.max(query.skip ?? 0, 0);
    const statuses = resolveStatuses(query);
    const search = query.search?.trim();
    const now = query.now ?? new Date();
    // Фильтры, которым нужен второй проход по живым строкам (JSON попыток,
    // дубли, активная подписка): строк немного, поэтому собираем id заранее и
    // отдаём их в `where` — так и пагинация, и счётчик остаются точными.
    const prefiltered = await this.prefilterIds(query, now);

    const where = {
      status: { in: statuses },
      ...this.healthWhere(query.health, now),
      ...this.dueWhere(query.dueInDays, now),
      ...(query.hiddenOnly === true
        ? { hiddenAt: { not: null } }
        : query.includeHidden === true
          ? {}
          : { hiddenAt: null }),
      ...(query.gateway === undefined ? {} : { gatewayType: query.gateway }),
      ...(query.method === undefined ? {} : { method: query.method }),
      ...(query.strandedOnly === true ? { strandedReason: { not: null } } : {}),
      ...(prefiltered === null ? {} : { id: { in: prefiltered } }),
      ...this.dueWhere(query.dueInDays, now),
      ...(search === undefined || search.length === 0
        ? {}
        : {
            user: {
              is: {
                OR: [
                  { username: { contains: search, mode: 'insensitive' as const } },
                  { email: { contains: search, mode: 'insensitive' as const } },
                  { name: { contains: search, mode: 'insensitive' as const } },
                ],
              },
            },
          }),
    };

    const [total, rows] = await this.prismaService.$transaction([
      this.prismaService.providerSubscription.count({ where }),
      this.prismaService.providerSubscription.findMany({
        where,
        orderBy: [{ nextChargeAt: 'asc' }, { createdAt: 'desc' }],
        take,
        skip,
        select: {
          id: true,
          userId: true,
          gatewayType: true,
          method: true,
          status: true,
          providerStatus: true,
          createdAt: true,
          nextChargeAt: true,
          lastChargeAt: true,
          lastSyncedAt: true,
          endsAt: true,
          amount: true,
          currency: true,
          planId: true,
          attempts: true,
          subscriptionId: true,
          appliedChargeCount: true,
          plannedChargeCount: true,
          stalledSince: true,
          strandedReason: true,
          strandedAt: true,
          cancelAttempts: true,
          cancelNextTryAt: true,
          cancelLastError: true,
          manualCancelRequired: true,
          providerRecurrentId: true,
          hiddenAt: true,
          hiddenReason: true,
          user: { select: { username: true, email: true, telegramId: true } },
        },
      }),
    ]);

    // VPN-подписка — отдельной выборкой: прямой связи в схеме нет, только id.
    const subscriptionIds = rows
      .map((row) => row.subscriptionId)
      .filter((id): id is string => id !== null);
    const subscriptions = subscriptionIds.length === 0
      ? []
      : await this.prismaService.subscription.findMany({
          where: { id: { in: subscriptionIds } },
          select: { id: true, expiresAt: true },
        });
    const expiresById = new Map(subscriptions.map((sub) => [sub.id, sub.expiresAt] as const));

    // Дубли: живые строки одной подписки. Считаем по всей базе, а не по
    // странице — иначе на второй странице дубль выглядел бы единственным.
    const liveRows = subscriptionIds.length === 0
      ? []
      : await this.prismaService.providerSubscription.findMany({
          where: {
            subscriptionId: { in: subscriptionIds },
            status: { in: ['ACTIVE', 'PAST_DUE', 'PENDING'] },
            hiddenAt: null,
          },
          select: { id: true, subscriptionId: true },
        });
    const liveBySubscription = new Map<string, string[]>();
    for (const live of liveRows) {
      if (live.subscriptionId === null) continue;
      const list = liveBySubscription.get(live.subscriptionId) ?? [];
      list.push(live.id);
      liveBySubscription.set(live.subscriptionId, list);
    }

    // Чем продлено последнее: последняя COMPLETED-транзакция по подписке.
    // Оператору важно отличить продление самим рекуррентом от ручной оплаты —
    // именно это и создаёт «двойные» строки.
    const renewals = subscriptionIds.length === 0
      ? []
      : await this.prismaService.transaction.findMany({
          where: {
            subscriptionId: { in: subscriptionIds },
            status: 'COMPLETED',
            // Год назад — с запасом: старые продления не нужны, а без границы
            // запрос тянул бы всю историю подписок страницы.
            createdAt: { gte: new Date(now.getTime() - 400 * DAY_MS) },
          },
          orderBy: { createdAt: 'desc' },
          take: Math.min(subscriptionIds.length * 10, 500),
          select: {
            id: true,
            subscriptionId: true,
            createdAt: true,
            purchaseType: true,
            gatewayType: true,
            gatewayData: true,
            idempotencyKey: true,
          },
        });
    const lastRenewalBySubscription = new Map<string, (typeof renewals)[number]>();
    for (const renewal of renewals) {
      if (renewal.subscriptionId === null) continue;
      if (!lastRenewalBySubscription.has(renewal.subscriptionId)) {
        lastRenewalBySubscription.set(renewal.subscriptionId, renewal);
      }
    }

    const items = rows.map((row): AdminAutopayRowInterface => {
      const history = readAutopayAttempts(row.attempts);
      return {
        providerSubscriptionRowId: row.id,
        userId: row.userId,
        login: row.user?.username ?? null,
        email: row.user?.email ?? null,
        telegramId: row.user?.telegramId === null || row.user?.telegramId === undefined
          ? null
          : row.user.telegramId.toString(),
        gatewayType: row.gatewayType,
        method: row.method,
        status: row.status,
        providerStatus: row.providerStatus,
        health: autopayHealth({
          status: row.status,
          providerStatus: row.providerStatus,
          nextChargeAt: row.nextChargeAt,
          now,
        }),
        connectedAt: row.createdAt.toISOString(),
        nextChargeAt: row.nextChargeAt?.toISOString() ?? null,
        lastChargeAt: row.lastChargeAt?.toISOString() ?? null,
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
        expiresAt: row.subscriptionId === null
          ? null
          : (expiresById.get(row.subscriptionId)?.toISOString() ?? null),
        attempts: summariseAutopayAttempts(row.attempts),
        history: history.slice(Math.max(0, history.length - HISTORY_IN_ROW)),
        chargeIds: autopayChargeIds(row.attempts, CHARGE_IDS_IN_ROW),
        amount: row.amount.toString(),
        currency: row.currency,
        planId: row.planId,
        appliedChargeCount: row.appliedChargeCount,
        plannedChargeCount: row.plannedChargeCount,
        endsAt: row.endsAt?.toISOString() ?? null,
        stalledSince: row.stalledSince?.toISOString() ?? null,
        strandedReason: row.strandedReason,
        strandedAt: row.strandedAt?.toISOString() ?? null,
        cancelAttempts: row.cancelAttempts,
        cancelNextTryAt: row.cancelNextTryAt?.toISOString() ?? null,
        cancelLastError: row.cancelLastError,
        manualCancelRequired: row.manualCancelRequired,
        providerRecurrentId: row.providerRecurrentId,
        duplicateRowIds: row.subscriptionId === null
          ? []
          : (liveBySubscription.get(row.subscriptionId) ?? []).filter((id) => id !== row.id),
        lastRenewal: (() => {
          if (row.subscriptionId === null) return null;
          const renewal = lastRenewalBySubscription.get(row.subscriptionId);
          if (renewal === undefined) return null;
          return {
            transactionId: renewal.id,
            at: renewal.createdAt.toISOString(),
            gatewayType: renewal.gatewayType,
            purchaseType: renewal.purchaseType,
            isAutopay: (renewal.idempotencyKey ?? '').startsWith('provider-subscription:'),
          };
        })(),
        hiddenAt: row.hiddenAt?.toISOString() ?? null,
        hiddenReason: row.hiddenReason,
      };
    });

    return { items, total, take, skip };
  }

  /** Условие «здоровье» для `where`: STALLED и DESYNC выражаются полями строки. */
  private healthWhere(
    health: string | undefined,
    now: Date,
  ): Record<string, unknown> {
    const key = (health ?? '').trim().toUpperCase();
    const stalledAfter = new Date(now.getTime() - STALLED_AFTER_MS);
    if (key === 'STALLED') {
      return {
        status: { in: ['ACTIVE', 'PAST_DUE'] },
        providerStatus: { in: ['PROCESSING', 'ACTIVE_FAILED'] },
        nextChargeAt: { lt: stalledAfter },
      };
    }
    if (key === 'DESYNC') {
      return {
        status: 'ACTIVE',
        nextChargeAt: { lt: now },
        NOT: {
          providerStatus: { in: ['PROCESSING', 'ACTIVE_FAILED'] },
          nextChargeAt: { lt: stalledAfter },
        },
      };
    }
    if (key === 'PAST_DUE') return { status: 'PAST_DUE' };
    return {};
  }

  /** Списание в ближайшие N дней: 0 — сегодня, без значения — не фильтруем. */
  private dueWhere(
    dueInDays: number | undefined,
    now: Date,
  ): Record<string, unknown> {
    if (dueInDays === undefined) return {};
    const end = new Date(now.getTime() + Math.max(dueInDays, 0) * DAY_MS);
    return {
      status: { in: ['ACTIVE', 'PAST_DUE'] },
      nextChargeAt: { gte: startOfDay(now), lte: end },
    };
  }

  /**
   * Id строк, которые проходят фильтры, требующие разбора данных: неуспешные
   * попытки (`attempts` — JSON), дубли (нужна группировка) и PAST_DUE с живой
   * подпиской. Живых строк немного, поэтому проход по ним дешевле, чем
   * несколько запросов с JSON-условиями на каждую страницу.
   */
  private async prefilterIds(
    query: { readonly duplicatesOnly?: boolean; readonly failedAttemptsOnly?: boolean; readonly pastDueWithActive?: boolean },
    now: Date,
  ): Promise<string[] | null> {
    const needAttempts = query.failedAttemptsOnly === true;
    const needDuplicates = query.duplicatesOnly === true;
    const needActive = query.pastDueWithActive === true;
    if (!needAttempts && !needDuplicates && !needActive) return null;

    const live = await this.prismaService.providerSubscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'PAST_DUE', 'PENDING'] },
        hiddenAt: null,
      },
      select: { id: true, subscriptionId: true, status: true, attempts: true },
    });

    let ids = live.map((row) => row.id);
    if (needDuplicates) {
      const perSubscription = new Map<string, number>();
      for (const row of live) {
        if (row.subscriptionId === null) continue;
        perSubscription.set(row.subscriptionId, (perSubscription.get(row.subscriptionId) ?? 0) + 1);
      }
      const duplicated = new Set(
        [...perSubscription.entries()].filter(([, count]) => count > 1).map(([id]) => id),
      );
      ids = live
        .filter((row) => row.subscriptionId !== null && duplicated.has(row.subscriptionId))
        .map((row) => row.id);
    }
    if (needAttempts) {
      const failing = new Set(
        live
          .filter((row) => summariseAutopayAttempts(row.attempts).failed > 0)
          .map((row) => row.id),
      );
      ids = ids.filter((id) => failing.has(id));
    }
    if (needActive) {
      const subscriptionIds = [
        ...new Set(live.flatMap((row) => (row.subscriptionId === null ? [] : [row.subscriptionId]))),
      ];
      const active =
        subscriptionIds.length === 0
          ? []
          : await this.prismaService.subscription.findMany({
              where: { id: { in: subscriptionIds }, expiresAt: { gt: now } },
              select: { id: true },
            });
      const activeIds = new Set(active.map((row) => row.id));
      const pastDueActive = new Set(
        live
          .filter(
            (row) =>
              row.status === 'PAST_DUE' &&
              row.subscriptionId !== null &&
              activeIds.has(row.subscriptionId),
          )
          .map((row) => row.id),
      );
      ids = ids.filter((id) => pastDueActive.has(id));
    }
    return ids;
  }

  /**
   * CSV текущего фильтра. Только внутренние id: ни логинов, ни email, ни
   * телефонов — выгрузку пересылают, и персональные данные в ней не нужны.
   */
  public async exportCsv(
    query: Parameters<AdminAutopayService['listAll']>[0],
    now: Date = new Date(),
  ): Promise<string> {
    const collected: AdminAutopayRowInterface[] = [];
    const pageSize = 200;
    const cap = 2_000;
    for (let skip = 0; skip < cap; skip += pageSize) {
      const page = await this.listAll({ ...query, take: pageSize, skip, now });
      collected.push(...page.items);
      if (page.items.length === 0 || collected.length >= page.total) break;
    }

    const header = [
      'row_id',
      'user_id',
      'telegram_id',
      'gateway',
      'method',
      'status',
      'provider_status',
      'health',
      'connected_at',
      'next_charge_at',
      'last_charge_at',
      'amount',
      'currency',
      'charges_applied',
      'charges_planned',
      'subscription_expires_at',
      'cancel_attempts',
      'manual_cancel_required',
      'provider_recurrent_id',
      'stranded_reason',
      'charge_ids',
    ];
    const lines = [header.join(',')];
    for (const row of collected) {
      lines.push(
        [
          row.providerSubscriptionRowId,
          row.userId ?? '',
          row.telegramId ?? '',
          row.gatewayType,
          row.method ?? '',
          row.status,
          row.providerStatus ?? '',
          row.health,
          row.connectedAt,
          row.nextChargeAt ?? '',
          row.lastChargeAt ?? '',
          row.amount,
          row.currency,
          String(row.appliedChargeCount),
          row.plannedChargeCount === null ? '' : String(row.plannedChargeCount),
          row.expiresAt ?? '',
          String(row.cancelAttempts),
          row.manualCancelRequired ? 'true' : 'false',
          row.providerRecurrentId ?? '',
          row.strandedReason ?? '',
          row.chargeIds.join(' '),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\r\n');
  }

  /**
   * Сводка вкладки: сколько строк в каждом статусе и сколько денег ждём в
   * ближайшие 7 и 30 дней. Зависшие в сумму не попадают — по ним списания не
   * будет, пока провайдер не сдвинет дату.
   */
  public async summarise(now: Date = new Date()): Promise<AdminAutopaySummaryInterface> {
    const grouped = await this.prismaService.providerSubscription.groupBy({
      by: ['status'],
      where: { hiddenAt: null },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const row of grouped) byStatus[row.status] = row._count._all;

    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcoming = await this.prismaService.providerSubscription.findMany({
      where: {
        status: { in: [ProviderSubscriptionStatus.ACTIVE, ProviderSubscriptionStatus.PAST_DUE] },
        nextChargeAt: { gt: now, lte: in30Days },
        hiddenAt: null,
      },
      select: { nextChargeAt: true, amount: true, currency: true, status: true, providerStatus: true },
    });

    const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expected: Record<string, { in7d: number; in30d: number }> = {};
    let stalled = 0;
    for (const row of upcoming) {
      if (
        autopayHealth({
          status: row.status,
          providerStatus: row.providerStatus,
          nextChargeAt: row.nextChargeAt,
          now,
        }) === 'STALLED'
      ) {
        stalled += 1;
        continue;
      }
      const bucket = (expected[row.currency] ??= { in7d: 0, in30d: 0 });
      const amount = Number(row.amount);
      if (!Number.isFinite(amount)) continue;
      bucket.in30d += amount;
      if (row.nextChargeAt !== null && row.nextChargeAt.getTime() <= week.getTime()) bucket.in7d += amount;
    }

    const byHealth: Record<string, number> = { OK: 0, STALLED: 0, PAST_DUE: 0, DESYNC: 0 };
    const live = await this.prismaService.providerSubscription.findMany({
      where: {
        status: {
          in: [
            ProviderSubscriptionStatus.ACTIVE,
            ProviderSubscriptionStatus.PAST_DUE,
            ProviderSubscriptionStatus.PENDING,
          ],
        },
        hiddenAt: null,
      },
      select: { status: true, providerStatus: true, nextChargeAt: true },
    });
    for (const row of live) {
      const health = autopayHealth({
        status: row.status,
        providerStatus: row.providerStatus,
        nextChargeAt: row.nextChargeAt,
        now,
      });
      byHealth[health] = (byHealth[health] ?? 0) + 1;
    }

    return {
      byStatus,
      byHealth,
      stalled: byHealth['STALLED'] ?? 0,
      expected: Object.entries(expected).map(([currency, value]) => ({
        currency: currency as AdminAutopaySummaryInterface['expected'][number]['currency'],
        in7d: value.in7d.toFixed(2),
        in30d: value.in30d.toFixed(2),
      })),
    };
  }

  /**
   * «Отменено вручную в ЛК»: оператор сам отменил рекуррент в кабинете
   * провайдера. Сверяемся — если провайдер подтвердил отмену, строка
   * становится CANCELLED и скрывается из таблицы.
   */
  public async markCancelledInCabinet(rowId: string): Promise<{
    readonly status: string;
    readonly providerStatus: string | null;
    readonly hidden: boolean;
  }> {
    return this.providerSubscriptions.markCancelledInCabinet(rowId);
  }

  /**
   * «Отменить автосписание» из таблицы: строку ищем по её id, владельца берём
   * из неё же — оператору не нужно знать userId.
   */
  public async cancelById(input: {
    readonly providerSubscriptionRowId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<AdminProviderAutopayCancelResultInterface> {
    const row = await this.prismaService.providerSubscription.findUnique({
      where: { id: input.providerSubscriptionRowId },
      select: { id: true, userId: true },
    });
    if (row === null || row.userId === null) {
      throw new NotFoundException('Autopay subscription not found');
    }
    return this.cancelProviderSubscription({
      userId: row.userId,
      providerSubscriptionRowId: row.id,
      currentAdmin: input.currentAdmin,
      requestMetadata: input.requestMetadata,
    });
  }

  /**
   * «Отменить автосписание» of one Platega or RollyPay subscription: marked
   * now, cancelled at the provider after the answer, then the card.
   */
  public async cancelProviderSubscription(input: {
    readonly userId: string;
    readonly providerSubscriptionRowId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<AdminProviderAutopayCancelResultInterface> {
    const owned = await this.prismaService.providerSubscription.findFirst({
      where: { id: input.providerSubscriptionRowId, userId: input.userId },
      select: { id: true },
    });
    if (owned === null) {
      throw new NotFoundException('Provider subscription not found');
    }
    const marked = await this.providerSubscriptions.markForOperatorCancel(owned.id);
    if (marked.state === 'NOT_FOUND') {
      throw new NotFoundException('Provider subscription not found');
    }
    if (marked.state !== 'MARKED') {
      return { state: marked.state };
    }
    const row = marked.row;
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: 'payments.autopay.provider_subscription_cancelled',
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          requestId: input.requestMetadata.requestId,
          userId: input.userId,
          providerSubscriptionRowId: row.id,
          gatewayType: row.gatewayType,
          providerSubscriptionId: row.providerSubscriptionId,
          subscriptionId: row.subscriptionId,
          amount: row.amount.toString(),
          currency: row.currency,
        },
      }),
    });
    const planName = await this.planName(row.planId);
    let told = false;
    const tell = (outcome: AutopayRefundOutcome | 'INTERRUPTED'): void => {
      if (told) return;
      told = true;
      this.announceProviderCancel(row, input.currentAdmin.id, planName, outcome);
    };
    this.runAfterResponse(
      `the operator's cancel of provider subscription ${row.id}`,
      async () => tell(await this.providerSubscriptions.cancelForOperator(row.id)),
      () => tell('INTERRUPTED'),
    );
    return { state: 'CANCELLING' };
  }

  /**
   * «Выключить автосписание ЮKassa»: every active ЮKassa method of the
   * customer stops being charged by the renewal. The methods stay saved.
   */
  public async disableYookassaAutopay(input: {
    readonly userId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<AdminYookassaAutopayDisableResultInterface> {
    await this.requireUser(input.userId);
    const first = await this.savedPaymentMethods.disableAutopayForOperator({
      userId: input.userId,
      adminId: input.currentAdmin.id,
      waitForCharges: false,
    });
    if (first.switched.length === 0 && first.busy === 0) {
      return { switched: 0, pending: 0 };
    }
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: 'payments.autopay.yookassa_disabled',
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          requestId: input.requestMetadata.requestId,
          userId: input.userId,
          switchedMethodIds: first.switched.map((method) => method.id),
          pending: first.busy,
        },
      }),
    });
    if (first.busy === 0) {
      this.announceYookassaDisable(input.userId, input.currentAdmin.id, first.switched, { failed: false, interrupted: false });
      return { switched: first.switched.length, pending: 0 };
    }
    let told = false;
    const tell = (late: readonly SwitchedOffMethod[], failed: boolean, interrupted: boolean): void => {
      if (told) return;
      told = true;
      this.announceYookassaDisable(input.userId, input.currentAdmin.id, [...first.switched, ...late], { failed, interrupted });
    };
    this.runAfterResponse(
      `the operator's switch-off of the ЮKassa autopay of user ${input.userId}`,
      async () => {
        try {
          const late = await this.savedPaymentMethods.disableAutopayForOperator({
            userId: input.userId,
            adminId: input.currentAdmin.id,
            waitForCharges: true,
          });
          tell(late.switched, false, false);
        } catch (error: unknown) {
          this.logger.error(
            `Could not switch off the ЮKassa autopay of user ${input.userId} after a charge: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          tell([], true, false);
        }
      },
      () => tell([], false, true),
    );
    return { switched: first.switched.length, pending: first.busy };
  }

  /** Waits for the work after the answers under way (a spec's, and a stop's, handle). */
  public async settleAfterResponse(): Promise<void> {
    while (this.underWay.size > 0) {
      await Promise.all([...this.underWay.keys()]);
    }
  }

  /**
   * A stop never loses a card: the work under way gets
   * {@link AFTER_RESPONSE_SHUTDOWN_WAIT_MS}, then every card still owed goes
   * out saying the provider had not answered. The rows are marked, so the
   * sweep finishes a cancel the stop cut.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.underWay.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.settleAfterResponse(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AFTER_RESPONSE_SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const { label, interrupted } of this.underWay.values()) {
      this.logger.warn(`${label} was cut by the stop; its card goes out as it stands`);
      try {
        interrupted();
      } catch (error: unknown) {
        this.logger.error(`${label}: its card could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Runs `work` past the answer, tracked until done. Never rejects. */
  private runAfterResponse(label: string, work: () => Promise<void>, interrupted: () => void): void {
    const task: Promise<void> = work()
      .catch((error: unknown) => {
        this.logger.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.underWay.delete(task);
      });
    this.underWay.set(task, { label, interrupted });
  }

  private announceProviderCancel(
    row: ProviderSubscription,
    adminId: string,
    planName: string | null,
    outcome: AutopayRefundOutcome | 'INTERRUPTED',
  ): void {
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR,
      'PAYMENT',
      `Автосписание отключено в панели: ${row.gatewayType}`,
      {
        userId: row.userId,
        adminId,
        gatewayType: row.gatewayType,
        providerSubscriptionId: row.providerSubscriptionId,
        ...(row.subscriptionId === null ? {} : { subscriptionId: row.subscriptionId }),
        ...(planName === null ? {} : { planName }),
        amount: row.amount.toString(),
        currency: row.currency,
        note: describeOperatorProviderCancel(row.gatewayType, outcome),
      },
    );
  }

  private announceYookassaDisable(
    userId: string,
    adminId: string,
    switched: readonly SwitchedOffMethod[],
    how: { readonly failed: boolean; readonly interrupted: boolean },
  ): void {
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR,
      'PAYMENT',
      'Автосписание отключено в панели: YOOKASSA',
      {
        userId,
        adminId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        note: describeOperatorYookassaDisable(switched, how),
      },
    );
  }

  private async planName(planId: string): Promise<string | null> {
    try {
      const plan = await this.prismaService.plan.findUnique({ where: { id: planId }, select: { name: true } });
      return plan?.name ?? null;
    } catch {
      return null;
    }
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prismaService.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
  }
}

/** The name the panel shows for a gateway that runs a provider subscription. */
function providerName(gatewayType: string): string {
  if (gatewayType === PaymentGatewayType.PLATEGA) return 'Platega';
  if (gatewayType === PaymentGatewayType.ROLLYPAY) return 'RollyPay';
  if (gatewayType === PaymentGatewayType.ANTILOPAY) return 'Antilopay';
  if (gatewayType === PaymentGatewayType.AURAPAY) return 'AuraPay';
  return gatewayType;
}

/**
 * The «📝 Заметка» of the operator's cancel of a provider autopay: what the
 * provider did, what the customer sees, and what to do when it did not answer.
 */
export function describeOperatorProviderCancel(
  gatewayType: string,
  outcome: AutopayRefundOutcome | 'INTERRUPTED',
): string {
  const provider = providerName(gatewayType);
  if (outcome === 'INTERRUPTED') {
    return (
      `Отмена у ${provider} не успела завершиться до перезапуска панели: панель повторяет её каждые 10 минут. ` +
      `Чтобы остановить списания сразу, отмените подписку в личном кабинете ${provider}.`
    );
  }
  if (outcome.cancelled.length > 0) {
    return (
      `Автосписание отменено у ${provider}: новых списаний не будет. Оплаченный срок подписки не меняется. ` +
      'Клиенту панель ничего не сообщала; в кабинете, в «Способах оплаты», этого автосписания больше нет.'
    );
  }
  if (outcome.failed.some((row) => row.gatewayType === UNKNOWN_AUTOPAY_GATEWAY)) {
    return (
      'Проверить автосписание не удалось: панель повторяет отмену каждые 10 минут. ' +
      `Проверьте подписку клиента в личном кабинете ${provider} и при необходимости отмените её там.`
    );
  }
  if (outcome.failed.length > 0) {
    return (
      `Отменить автосписание у ${provider} сразу не удалось: панель повторяет отмену каждые 10 минут. ` +
      `Чтобы остановить списания сразу, отмените подписку в личном кабинете ${provider}.`
    );
  }
  return 'Автосписание уже было отменено раньше — отменять было нечего.';
}

/** The «📝 Заметка» of the operator's switch-off of the ЮKassa autopay. */
export function describeOperatorYookassaDisable(
  switched: readonly SwitchedOffMethod[],
  how: { readonly failed: boolean; readonly interrupted: boolean },
): string {
  const parts: string[] = [];
  if (switched.length > 0) {
    parts.push(
      `Автосписание через ЮKassa выключено: ${switched.map((method) => method.title).join(', ')}. ` +
        'Способы оплаты остались привязанными. Клиенту панель ничего не сообщала; в кабинете, в «Способах оплаты», ' +
        'у них выключен переключатель «Автосписание», и клиент может включить его снова.',
    );
  }
  if (how.failed) {
    parts.push(
      'Один способ оплаты в этот момент использовался для списания, и выключить на нём автосписание потом не удалось: ' +
        'следующее продление может списать деньги. Нажмите «Выключить автосписание ЮKassa» в карточке клиента ещё раз.',
    );
  } else if (how.interrupted) {
    parts.push(
      'Один способ оплаты в этот момент использовался для списания, а панель перезапустилась раньше, чем оно кончилось: ' +
        'автосписание на нём могло остаться включённым. Нажмите «Выключить автосписание ЮKassa» в карточке клиента ещё раз.',
    );
  }
  return parts.length === 0 ? 'Автосписание через ЮKassa уже было выключено.' : parts.join(' ');
}

/**
 * Статусы для запроса: явный список, одиночный статус или режим «все».
 *
 * По умолчанию — ACTIVE и PAST_DUE: это то, за чем следят. PENDING (клиент ещё
 * не подтвердил) и завершённые прячутся за фильтром, иначе таблица тонет в
 * истории и в неактивных подписках.
 */
function resolveStatuses(query: {
  readonly status?: ProviderSubscriptionStatus;
  readonly statuses?: string;
  readonly includeEnded?: boolean;
}): ProviderSubscriptionStatus[] {
  const known = new Set<ProviderSubscriptionStatus>(Object.values(ProviderSubscriptionStatus));
  const parsed = (query.statuses ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is ProviderSubscriptionStatus =>
      known.has(value as ProviderSubscriptionStatus),
    );
  if (parsed.length > 0) return parsed;
  if (query.status !== undefined) return [query.status];
  if (query.includeEnded === true) return [...known];
  return [ProviderSubscriptionStatus.ACTIVE, ProviderSubscriptionStatus.PAST_DUE];
}
