import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentAuth, Public, RequirePermission, UserOnly } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import { Errors } from '../../common/errors/app-error';
import { PaginationQueryDto } from '../../common/util/pagination';
import { BillingService } from './billing.service';
import { BILLING_PROVIDER, type BillingProvider } from './billing-provider';

class CheckoutDto {
  @ApiPropertyOptional({ example: 'PRO', description: 'Plano (1 mês) — informe planCode OU packCode' })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,30}$/)
  planCode?: string;

  @ApiPropertyOptional({ example: 'EXTRA_10', description: 'Pacote de documentos extras' })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,30}$/)
  packCode?: string;
}

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) return firstString(v[0]);
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Plano atual, uso e planos disponíveis para contratação' })
  overview(@CurrentAuth() auth: AuthContext) {
    return this.billing.overview(auth);
  }

  @UserOnly()
  @RequirePermission(Permission.ORG_SETTINGS)
  @Post('checkout')
  @ApiOperation({ summary: 'Inicia a compra de um plano ou pacote: devolve a URL da página de pagamento (Pix ou cartão à vista)' })
  checkout(@CurrentAuth() auth: AuthContext, @Body() dto: CheckoutDto, @Req() req: Request) {
    if (!!dto.planCode === !!dto.packCode) throw Errors.validation('Informe planCode ou packCode.');
    return this.billing.checkout(auth, dto.planCode ? { planCode: dto.planCode } : { packCode: dto.packCode! }, clientInfo(req));
  }

  @RequirePermission(Permission.ORG_SETTINGS)
  @Get('payments')
  payments(@CurrentAuth() auth: AuthContext, @Query() q: PaginationQueryDto) {
    return this.billing.list(auth, q);
  }

  @RequirePermission(Permission.ORG_SETTINGS)
  @Get('payments/:id')
  @ApiOperation({ summary: 'Situação de um pagamento (consultada no provedor pelo backend)' })
  payment(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.get(auth, id);
  }

  /**
   * Notificações do Mercado Pago. Nada do corpo é confiado: só o id do pagamento é usado para
   * reconsultá-lo na API do Mercado Pago com a credencial do servidor.
   */
  @Public()
  @RateLimit('billing_webhook')
  @HttpCode(200)
  @Post('webhooks/mercadopago')
  @ApiExcludeEndpoint()
  async mercadoPagoWebhook(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    if (this.provider.name !== 'mercadopago') throw Errors.notFound('NOT_FOUND', 'Não encontrado.');
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const data = (typeof body.data === 'object' && body.data !== null ? body.data : {}) as Record<string, unknown>;
    const type = firstString(req.query.type) ?? firstString(req.query.topic) ?? firstString(body.type) ?? firstString(body.topic);
    const dataId = firstString(req.query['data.id']) ?? firstString(req.query.id) ?? (data.id !== undefined ? String(data.id) : null);
    if (type !== 'payment' || !dataId || !/^\d{1,30}$/.test(dataId)) return { received: true };
    if (this.provider.verifyWebhook(req.headers, dataId) === 'invalid') throw Errors.unauthenticated('Assinatura inválida.');
    await this.billing.handleNotification(dataId);
    return { received: true };
  }
}
