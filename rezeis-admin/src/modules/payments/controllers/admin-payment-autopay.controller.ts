import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  AdminAutopayListInterface,
  AdminAutopayService,
  AdminAutopaySummaryInterface,
  AdminProviderAutopayCancelResultInterface,
  AdminUserAutopayInterface,
  AdminYookassaAutopayDisableResultInterface,
} from '../services/admin-autopay.service';
import { AdminAutopayListQueryDto } from '../dto/admin-autopay-list-query.dto';

/**
 * A customer's autopays on the user's card in the panel: what they are, and
 * the operator's «Отменить автосписание» without a refund.
 *
 * Reading is `payments:view`. Ending one is `payments:edit` — the payments
 * action that changes a customer's payment arrangements and moves no money
 * (`payments:refund` gives money back; `subscriptions:edit` changes access,
 * not how it is paid for); the Finance role holds it.
 */
@Controller('admin/payments/autopay')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminPaymentAutopayController {
  public constructor(private readonly adminAutopayService: AdminAutopayService) {}

  /**
   * Таблица «Автосписания»: все живые автосписания клиентов.
   *
   * `payments:view` — то же право, которым читается карточка клиента: это те же
   * данные, только списком.
   */
  @Get()
  @ApiOperation({ summary: 'Автосписания клиентов: логин, дата подключения, попытки, следующее списание' })
  @RequirePermission('payments', 'view')
  public async list(@Query() query: AdminAutopayListQueryDto): Promise<AdminAutopayListInterface> {
    return this.adminAutopayService.listAll(query);
  }

  /**
   * Сводка вкладки: строки по статусам, по здоровью и ожидаемые списания на
   * 7 и 30 дней. Отдельный запрос — таблица листается, сводка нет.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Сводка автосписаний: статусы, здоровье, ожидаемые суммы' })
  @RequirePermission('payments', 'view')
  public async summary(): Promise<AdminAutopaySummaryInterface> {
    return this.adminAutopayService.summarise();
  }

  /**
   * «Отменить автосписание» из таблицы. Владельца берём из строки, чтобы
   * оператору не нужно было открывать карточку клиента.
   */
  @Post(':providerSubscriptionRowId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить автосписание по строке таблицы' })
  @RequirePermission('payments', 'edit')
  public async cancelById(
    @Param('providerSubscriptionRowId') providerSubscriptionRowId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminProviderAutopayCancelResultInterface> {
    return this.adminAutopayService.cancelById({
      providerSubscriptionRowId,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Get('users/:userId')
  @RequirePermission('payments', 'view')
  public async listForUser(@Param('userId') userId: string): Promise<AdminUserAutopayInterface> {
    return this.adminAutopayService.listForUser(userId);
  }

  /** «Отменить автосписание» of one Platega or RollyPay subscription; the provider is asked after the answer. */
  @Post('users/:userId/provider-subscriptions/:providerSubscriptionRowId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payments', 'edit')
  public async cancelProviderSubscription(
    @Param('userId') userId: string,
    @Param('providerSubscriptionRowId') providerSubscriptionRowId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminProviderAutopayCancelResultInterface> {
    return this.adminAutopayService.cancelProviderSubscription({
      userId,
      providerSubscriptionRowId,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  /** «Выключить автосписание ЮKassa»: every saved ЮKassa method of the customer. */
  @Post('users/:userId/yookassa/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payments', 'edit')
  public async disableYookassaAutopay(
    @Param('userId') userId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminYookassaAutopayDisableResultInterface> {
    return this.adminAutopayService.disableYookassaAutopay({
      userId,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }
}
