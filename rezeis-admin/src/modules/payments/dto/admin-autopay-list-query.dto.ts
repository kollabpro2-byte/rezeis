import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentGatewayType, ProviderSubscriptionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Фильтры таблицы «Автосписания».
 *
 * Страница и поиск — обычные; статус по умолчанию не задан, и сервис берёт
 * живые (`ACTIVE`, `PAST_DUE`, `PENDING`). Отменённые и несостоявшиеся
 * запрашиваются явно, чтобы таблица не заполнялась историей.
 */
export class AdminAutopayListQueryDto {
  @ApiPropertyOptional({ description: 'Логин, email или имя клиента' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly search?: string;

  @ApiPropertyOptional({
    description: 'Статусы через запятую: ACTIVE,PAST_DUE,PENDING,CANCELLED,FAILED',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly statuses?: string;

  @ApiPropertyOptional({ description: 'Добавить завершённые и несостоявшиеся' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly includeEnded?: boolean;

  @ApiPropertyOptional({ enum: ProviderSubscriptionStatus, description: 'Один статус (совместимость)' })
  @IsOptional()
  @IsEnum(ProviderSubscriptionStatus)
  public readonly status?: ProviderSubscriptionStatus;

  @ApiPropertyOptional({ enum: ['STALLED', 'DESYNC', 'PAST_DUE', 'OK'], description: 'Здоровье строки' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  public readonly health?: string;

  @ApiPropertyOptional({ enum: PaymentGatewayType, description: 'Шлюз: ANTILOPAY, PLATEGA, …' })
  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public readonly gateway?: PaymentGatewayType;

  @ApiPropertyOptional({ description: 'Метод провайдера: CARD или SBP' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  public readonly method?: string;

  @ApiPropertyOptional({ description: 'Только дубли: больше одной живой строки на подписку' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly duplicatesOnly?: boolean;

  @ApiPropertyOptional({ description: 'Списание в ближайшие N дней; 0 — сегодня' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  public readonly dueInDays?: number;

  @ApiPropertyOptional({ description: 'PAST_DUE, но VPN-подписка ещё активна' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly pastDueWithActive?: boolean;

  @ApiPropertyOptional({ description: 'Есть неуспешные попытки списания' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly failedAttemptsOnly?: boolean;

  @ApiPropertyOptional({ description: 'Помечены как лишние (stranded_reason заполнен)' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly strandedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Показать скрытые уборкой строки (только для аудита)' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly includeHidden?: boolean;

  @ApiPropertyOptional({ description: 'Скрытые уборкой строки: только они' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly hiddenOnly?: boolean;

  @ApiPropertyOptional({ description: 'Выгрузка CSV текущего фильтра' })
  @IsOptional()
  @Type(() => Boolean)
  public readonly csv?: boolean;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly take?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly skip?: number;
}
