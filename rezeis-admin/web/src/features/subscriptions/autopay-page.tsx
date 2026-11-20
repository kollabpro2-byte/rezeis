import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AlertTriangle, CalendarClock, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import { activeLocale } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FadeIn } from '@/lib/motion'
import { PageTitle } from '@/components/layout/page-title'
import { PermissionGate, useHasPermission } from '@/features/rbac'

/** Одна попытка автосписания, как её хранит `provider_subscriptions.attempts`. */
interface AutopayAttempt {
  readonly at: string
  readonly ok: boolean
  readonly amount?: string
  readonly error?: string | null
}

/** Строка таблицы: зеркало `AdminAutopayRowInterface`. */
interface AutopayRow {
  readonly providerSubscriptionRowId: string
  readonly userId: string | null
  readonly login: string | null
  readonly email: string | null
  readonly telegramId: string | null
  readonly gatewayType: string
  readonly method: string | null
  readonly status: string
  readonly connectedAt: string
  readonly nextChargeAt: string | null
  readonly lastChargeAt: string | null
  readonly expiresAt: string | null
  readonly attempts: {
    readonly succeeded: number
    readonly failed: number
    readonly lastSuccessAt: string | null
    readonly lastFailureAt: string | null
  }
  readonly history: readonly AutopayAttempt[]
  readonly amount: string
  readonly currency: string
  readonly planId: string
}

interface AutopayList {
  readonly items: readonly AutopayRow[]
  readonly total: number
  readonly take: number
  readonly skip: number
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ACTIVE: 'default',
  PENDING: 'outline',
  PAST_DUE: 'destructive',
  CANCELLED: 'secondary',
  FAILED: 'destructive',
}

const PAGE_SIZE = 50

function formatDateTime(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(activeLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * «Автосписания» — подпункт раздела «Подписки».
 *
 * Одна таблица по автосписаниям провайдеров: логин, платёжка, когда подключено,
 * сколько попыток было и когда, когда спишут в следующий раз и до какого числа
 * живёт подписка. Отсюда же оператор отменяет автосписание, не открывая
 * карточку клиента.
 *
 * Данные — `GET admin/payments/autopay` (`payments:view`), отмена —
 * `POST admin/payments/autopay/:rowId/cancel` (`payments:edit`).
 */
export default function AutopayPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canEdit = useHasPermission('payments', 'edit')
  const [search, setSearch] = useState('')
  const [includeEnded, setIncludeEnded] = useState(false)
  const [page, setPage] = useState(0)

  const queryParams = useMemo(() => {
    const params = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) })
    if (search.trim().length > 0) params.set('search', search.trim())
    if (!includeEnded) params.set('status', 'ACTIVE')
    return params.toString()
  }, [search, includeEnded, page])

  const { data, isLoading, refetch, isFetching } = useQuery<AutopayList>({
    queryKey: adminQueryKeys.subscriptions.autopay(queryParams),
    queryFn: async ({ signal }) =>
      (await api.get<AutopayList>(`/admin/payments/autopay?${queryParams}`, { signal })).data,
    placeholderData: keepPreviousData,
  })

  const cancel = useMutation({
    mutationFn: async (row: AutopayRow) =>
      (await api.post(`/admin/payments/autopay/${row.providerSubscriptionRowId}/cancel`)).data,
    onSuccess: async () => {
      toast.success(t('autopayPage.cancelDone'))
      await queryClient.invalidateQueries({
        queryKey: adminQueryKeys.subscriptions.autopay(queryParams),
      })
    },
    onError: (error) => toast.error(getErrorMessage(error, t('autopayPage.cancelFailed'))),
  })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <PageTitle icon={CalendarClock} title={t('autopayPage.title')} />
            <p className="text-muted-foreground">{t('autopayPage.subtitle')}</p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            aria-label={t('autopayPage.refresh')}
          >
            <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
      </FadeIn>

      <div className="flex items-center gap-3 flex-wrap">
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(0)
          }}
          placeholder={t('autopayPage.searchPlaceholder')}
          className="w-64"
        />
        <Button
          variant={includeEnded ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            setIncludeEnded((value) => !value)
            setPage(0)
          }}
        >
          {t('autopayPage.endedFilter')}
        </Button>
        <div className="text-sm text-muted-foreground">{t('autopayPage.total', { count: total })}</div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <CalendarClock className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>{t('autopayPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('autopayPage.columns.login')}</TableHead>
                  <TableHead>{t('autopayPage.columns.gateway')}</TableHead>
                  <TableHead>{t('autopayPage.columns.connected')}</TableHead>
                  <TableHead>{t('autopayPage.columns.attempts')}</TableHead>
                  <TableHead>{t('autopayPage.columns.nextCharge')}</TableHead>
                  <TableHead>{t('autopayPage.columns.expires')}</TableHead>
                  <TableHead>{t('autopayPage.columns.status')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.providerSubscriptionRowId}>
                    <TableCell>
                      <div className="flex flex-col">
                        {row.userId !== null ? (
                          <Link to={`/users/${row.userId}`} className="font-medium hover:underline">
                            {row.login ?? row.email ?? row.telegramId ?? row.userId}
                          </Link>
                        ) : (
                          <span className="font-medium">
                            {row.login ?? row.email ?? row.telegramId ?? '—'}
                          </span>
                        )}
                        {row.login !== null && row.email !== null && (
                          <span className="text-xs text-muted-foreground">{row.email}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant="outline">{row.gatewayType}</Badge>
                        {row.method !== null && (
                          <span className="text-xs text-muted-foreground">{row.method}</span>
                        )}
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.amount} {row.currency}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {formatDateTime(row.connectedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="inline-flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {row.attempts.succeeded}
                          </span>
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <XCircle className="h-3.5 w-3.5" />
                            {row.attempts.failed}
                          </span>
                        </div>
                        {row.history.length > 0 && (
                          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground tabular-nums">
                            {row.history.slice(-3).map((attempt) => (
                              <span key={`${attempt.at}-${String(attempt.ok)}`}>
                                {attempt.ok ? '✔' : '✘'} {formatDateTime(attempt.at)}
                                {attempt.ok ? '' : ` — ${attempt.error ?? ''}`}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {formatDateTime(row.nextChargeAt)}
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {formatDateTime(row.expiresAt)}
                      {row.expiresAt !== null &&
                        row.nextChargeAt !== null &&
                        new Date(row.expiresAt) < new Date(row.nextChargeAt) && (
                          <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-amber-500" />
                        )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status] ?? 'outline'}>
                        {String(t(`autopayPage.statuses.${row.status}`, row.status))}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <PermissionGate resource="payments" action="edit">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canEdit || cancel.isPending || row.status === 'CANCELLED'}
                          onClick={() => cancel.mutate(row)}
                        >
                          {t('autopayPage.cancel')}
                        </Button>
                      </PermissionGate>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            {t('autopayPage.prev')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {page + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((value) => value + 1)}
          >
            {t('autopayPage.next')}
          </Button>
        </div>
      )}
    </div>
  )
}
