import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProviderSubscriptionStatus } from '@prisma/client';
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

  @ApiPropertyOptional({ enum: ProviderSubscriptionStatus })
  @IsOptional()
  @IsEnum(ProviderSubscriptionStatus)
  public readonly status?: ProviderSubscriptionStatus;

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
