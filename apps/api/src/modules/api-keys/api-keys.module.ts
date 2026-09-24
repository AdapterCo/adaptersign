import { Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { MemberRole } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { randomToken } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { CurrentAuth, RequirePermission, UserOnly } from '../../common/auth/decorators';
import { actorOf, Permission, ROLE_RANK, type AuthContext } from '../../common/auth/auth-context';
import { API_KEY_PREFIX } from '../../common/auth/tokens';
import { clientInfo, type ClientInfo } from '../../common/http/client-info';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { LimitsService } from '../billing/limits.service';

class CreateApiKeyDto {
  @ApiProperty({ example: 'Integração ERP' })
  @IsString()
  @Length(2, 80)
  name: string;

  @ApiPropertyOptional({ enum: [MemberRole.ADMIN, MemberRole.MEMBER, MemberRole.VIEWER], default: MemberRole.MEMBER })
  @IsOptional()
  @IsEnum(MemberRole)
  role?: MemberRole;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
  ) {}

  async list(auth: AuthContext) {
    return this.prisma.apiKey.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, role: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true },
    });
  }

  /** A chave completa é retornada SOMENTE aqui; persistimos apenas prefixo + hash. */
  async create(auth: AuthContext, dto: CreateApiKeyDto, client: ClientInfo) {
    const role = dto.role ?? MemberRole.MEMBER;
    if (role === MemberRole.OWNER || ROLE_RANK[role] > ROLE_RANK[auth.role]) throw Errors.forbidden('Papel não permitido para API key.');
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) throw Errors.validation('Expiração deve estar no futuro.');
    const prefix = `${API_KEY_PREFIX}${randomBytes(6).toString('hex')}`;
    const key = `${prefix}_${randomToken(32)}`;
    const created = await this.prisma.tx(async (tx) => {
      await this.limits.assertApiAccessAllowed(tx, auth.organizationId);
      const row = await tx.apiKey.create({
        data: {
          organizationId: auth.organizationId,
          name: dto.name.trim(),
          prefix,
          keyHash: this.encryption.hashToken(key, 'api_key'),
          role,
          createdById: auth.kind === 'user' ? auth.userId : null,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.API_KEY_CREATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { apiKeyId: row.id, prefix, role, expiresAt },
      });
      return row;
    });
    return { id: created.id, name: created.name, prefix, role, expiresAt, key };
  }

  async revoke(auth: AuthContext, id: string, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const res = await tx.apiKey.updateMany({ where: { id, organizationId: auth.organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (res.count === 0) throw Errors.notFound('API_KEY_NOT_FOUND', 'API key não encontrada ou já revogada.');
      await this.audit.record(tx, { eventType: AuditEventType.API_KEY_REVOKED, actor: actorOf(auth), organizationId: auth.organizationId, ...client, metadata: { apiKeyId: id } });
    });
  }
}

@ApiTags('api-keys')
@UserOnly()
@RequirePermission(Permission.API_KEYS_MANAGE)
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.keys.list(auth);
  }

  @Post()
  @ApiOperation({ summary: 'Cria API key (exibida uma única vez). Use: Authorization: Bearer <key>' })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateApiKeyDto, @Req() req: Request) {
    return this.keys.create(auth, dto, clientInfo(req));
  }

  @Delete(':id')
  async revoke(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.keys.revoke(auth, id, clientInfo(req));
    return { ok: true };
  }
}

@Module({ controllers: [ApiKeysController], providers: [ApiKeysService] })
export class ApiKeysModule {}
