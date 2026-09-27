import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, Matches, MaxLength } from 'class-validator';
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

/**
 * Cartão: somente o token de uso único do Mercado Pago e dados do pagador. Valor e parcelas NÃO
 * são aceitos do navegador (campos extras são recusados) — o backend usa o valor do pedido e 1 parcela.
 */
class CardPaymentDto {
  @ApiProperty({ description: 'Token gerado pelo componente do Mercado Pago' })
  @Matches(/^[A-Za-z0-9]{16,64}$/)
  token: string;

  @ApiProperty({ example: 'master' })
  @Matches(/^[a-z0-9_]{2,30}$/)
  paymentMethodId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{1,20}$/)
  issuerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  payerEmail?: string;

  @ApiPropertyOptional({ enum: ['CPF', 'CNPJ'] })
  @IsOptional()
  @IsIn(['CPF', 'CNPJ'])
  identificationType?: 'CPF' | 'CNPJ';

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[0-9./-]{11,20}$/)
  identificationNumber?: string;
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
  @ApiOperation({ summary: 'Cria o pedido de um plano ou pacote (valor definido no servidor); pague em seguida com Pix ou cartão' })
  checkout(@CurrentAuth() auth: AuthContext, @Body() dto: CheckoutDto, @Req() req: Request) {
    if (!!dto.planCode === !!dto.packCode) throw Errors.validation('Informe planCode ou packCode.');
    return this.billing.checkout(auth, dto.planCode ? { planCode: dto.planCode } : { packCode: dto.packCode! }, clientInfo(req));
  }

  @UserOnly()
  @RequirePermission(Permission.ORG_SETTINGS)
  @HttpCode(200)
  @Post('payments/:id/pix')
  @ApiOperation({ summary: 'Gera (ou reaproveita) o Pix do pedido — QR Code e copia-e-cola' })
  pix(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.billing.payWithPix(auth, id, clientInfo(req));
  }

  @UserOnly()
  @RequirePermission(Permission.ORG_SETTINGS)
  @HttpCode(200)
  @Post('payments/:id/card')
  @ApiOperation({ summary: 'Paga o pedido com cartão (crédito/débito à vista) usando o token do Mercado Pago' })
  card(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CardPaymentDto, @Req() req: Request) {
    return this.billing.payWithCard(auth, id, dto, clientInfo(req));
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
