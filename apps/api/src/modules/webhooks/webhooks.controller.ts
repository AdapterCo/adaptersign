import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { CurrentAuth, RequirePermission, UserOnly } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import { PaginationQueryDto } from '../../common/util/pagination';
import { PUBLIC_WEBHOOK_EVENTS } from '../outbox/domain-events';
import { WebhooksService } from './webhooks.service';

class CreateWebhookDto {
  @ApiProperty({ example: 'https://integracao.exemplo.com/webhooks/assinaturas' })
  @IsUrl({ require_protocol: true, require_tld: false })
  @MaxLength(2000)
  url: string;

  @ApiProperty({ isArray: true, enum: PUBLIC_WEBHOOK_EVENTS })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  events: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

class UpdateWebhookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false })
  @MaxLength(2000)
  url?: string;

  @ApiPropertyOptional({ isArray: true, enum: PUBLIC_WEBHOOK_EVENTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@ApiTags('webhooks')
@UserOnly()
@RequirePermission(Permission.WEBHOOKS_MANAGE)
@RateLimit('webhook_manage')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events')
  @ApiOperation({ summary: 'Lista eventos disponíveis para assinatura via webhook' })
  events() {
    return PUBLIC_WEBHOOK_EVENTS;
  }

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.webhooks.list(auth);
  }

  @Post()
  @ApiOperation({ summary: 'Cria webhook. O segredo HMAC é exibido somente nesta resposta.' })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateWebhookDto, @Req() req: Request) {
    return this.webhooks.create(auth, dto, clientInfo(req));
  }

  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWebhookDto, @Req() req: Request) {
    return this.webhooks.update(auth, id, dto, clientInfo(req));
  }

  @HttpCode(200)
  @Post(':id/rotate-secret')
  rotate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.webhooks.rotateSecret(auth, id, clientInfo(req));
  }

  @Delete(':id')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.webhooks.remove(auth, id, clientInfo(req));
    return { ok: true };
  }

  @Get(':id/deliveries')
  deliveries(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.webhooks.deliveries(auth, id, q);
  }

  @HttpCode(202)
  @Post('deliveries/:deliveryId/redeliver')
  async redeliver(@CurrentAuth() auth: AuthContext, @Param('deliveryId', ParseUUIDPipe) deliveryId: string) {
    await this.webhooks.redeliver(auth.organizationId, deliveryId);
    return { ok: true };
  }
}
