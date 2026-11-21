import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { activeLocale } from '@/lib/utils'
import { AXIS_TICK, BAR_CURSOR, GRID_STROKE } from '@/features/analytics/analytics-chart-support'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** Периоды, которые предлагает статистика. */
const PERIODS = ['all', 'day', '3d', '7d', '14d', '30d', '90d', '180d', '365d'] as const
type Period = (typeof PERIODS)[number]

/** Три категории автопродлений — общий срез для итогов, платёжек и графика. */
interface Breakdown {
  /** Автопродление сработало: деньги списаны, срок продлён. */
  readonly autopayRenewed: number
  /** Клиент продлил вручную, автопродление осталось живым. */
  readonly manualSupersededLive: number
  /** Клиент продлил вручную, и мы погасили автопродление. */
  readonly manualSupersededCancelled: number
}

interface StatsPayload extends Breakdown {
  readonly period: Period
  readonly from: string | null
  readonly to: string
  readonly bucketDays: number
  readonly totals: Breakdown
  readonly byGateway: ReadonlyArray<Breakdown & { readonly gatewayType: string }>
  readonly series: ReadonlyArray<Breakdown & { readonly bucket: string }>
}

/** Цвета серий: зелёный — сработало, янтарный — требует внимания, синий — погашено. */
const SERIES = [
  { key: 'autopayRenewed', color: '#10b981', label: 'renewed' },
  { key: 'manualSupersededLive', color: '#f59e0b', label: 'live' },
  { key: 'manualSupersededCancelled', color: '#3b82f6', label: 'cancelled' },
] as const


/**
 * Статистика автопродлений: сколько раз автопродление сработало, сколько раз
 * клиент оплатил вручную и что после этого стало с рекуррентом — остался живым
 * или мы его погасили. Период — от суток до «за всё время»; график по дням, а
 * на длинных периодах по неделям.
 */
export function AutopayStats() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>('30d')

  const { data, isLoading } = useQuery<StatsPayload>({
    queryKey: adminQueryKeys.subscriptions.autopay(`stats:${period}`),
    queryFn: async ({ signal }) =>
      (await api.get<StatsPayload>(`/admin/payments/autopay/stats?period=${period}`, { signal })).data,
  })

  const chartRows = useMemo(
    () =>
      (data?.series ?? []).map((point) => ({
        ...point,
        label: new Date(point.bucket).toLocaleDateString(activeLocale(), {
          day: '2-digit',
          month: '2-digit',
        }),
      })),
    [data?.series],
  )

  const totals = data?.totals
  const cards = [
    {
      key: 'renewed',
      value: totals?.autopayRenewed ?? 0,
      label: t('autopayStats.renewed'),
      hint: t('autopayStats.renewedHint'),
      accent: 'text-emerald-600',
    },
    {
      key: 'live',
      value: totals?.manualSupersededLive ?? 0,
      label: t('autopayStats.live'),
      hint: t('autopayStats.liveHint'),
      accent:
        totals !== undefined && totals.manualSupersededLive > 0 ? 'text-amber-600' : 'text-muted-foreground',
    },
    {
      key: 'cancelled',
      value: totals?.manualSupersededCancelled ?? 0,
      label: t('autopayStats.cancelled'),
      hint: t('autopayStats.cancelledHint'),
      accent: 'text-blue-600',
    },
  ]

  const isEmpty =

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">{t('autopayStats.title')}</p>
            <p className="text-xs text-muted-foreground">{t('autopayStats.subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PERIODS.map((value) => (
              <Button
                key={value}
                size="sm"
                variant={period === value ? 'default' : 'outline'}
                className="h-7 px-2 text-xs"
                onClick={() => setPeriod(value)}
              >
                {t(`autopayStats.periods.${value}`)}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {cards.map((card) => (
                <div key={card.key} className="rounded-xl border border-border/60 p-3">
                  <p className={`text-2xl font-bold tabular-nums ${card.accent}`}>{card.value}</p>
                  <p className="text-sm font-medium">{card.label}</p>
                  <p className="text-xs text-muted-foreground">{card.hint}</p>
                </div>
              ))}
            </div>

            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis
                    dataKey="label"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={{ stroke: GRID_STROKE }}
                    minTickGap={12}
                  />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                  <Tooltip
                    cursor={BAR_CURSOR}
                    isAnimationActive={false}
                    contentStyle={{
                      borderRadius: 12,
                      border: '1px solid var(--border)',
                      background: 'var(--popover)',
                      color: 'var(--popover-foreground)',
                      fontSize: 12,
                    }}
                    formatter={(value: number, name: string) => [
                      value,
                      t(`autopayStats.legend.${name}`, { defaultValue: name }),
                    ]}
                    labelFormatter={(label: string) =>
                      data?.bucketDays === 7 ? t('autopayStats.weekOf', { date: label }) : label
                    }
                  />
                  {SERIES.map((series, index) => (
                    <Bar
                      key={series.key}
                      dataKey={series.key}
                      name={series.label}
                      stackId="events"
                      fill={series.color}
                      radius={index === SERIES.length - 1 ? [4, 4, 0, 0] : undefined}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {SERIES.map((series) => (
                <span key={series.key} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: series.color }} />
                  {t(`autopayStats.legend.${series.label}`)}
                </span>
              ))}
              {data !== undefined && data.byGateway.length > 1 && (
                <span className="ml-auto">
                  {t('autopayStats.byGateway')}:{' '}
                  {data.byGateway
                    .map(
                      (row) =>
                        `${row.gatewayType} ${
                          row.autopayRenewed + row.manualSupersededLive + row.manualSupersededCancelled
                        }`,
                    )
                    .join(' · ')}
                </span>
              )}
            </div>

            {isEmpty && <p className="text-center text-sm text-muted-foreground">{t('autopayStats.empty')}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

    chartRows.length > 0 &&
    chartRows.every(
      (row) => row.autopayRenewed + row.manualSupersededLive + row.manualSupersededCancelled === 0,
    )
