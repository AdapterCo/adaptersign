import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { SignatureMethod } from '../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Public } from '../../common/auth/decorators';
import { SIGN_SESSION_COOKIE, cookieOptions } from '../../common/auth/tokens';
import { clientInfo } from '../../common/http/client-info';
import { contentDisposition } from '../../common/http/content-disposition';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import { SigningService } from './signing.service';
import { OtpService } from './otp.service';

const SIGN_PATH = '/api/v1/sign';

class OpenSessionDto {
  @ApiProperty({ description: 'Token opaco do link /sign/{token}' })
  @IsString()
  @Length(20, 100)
  token: string;
}

class RequestOtpDto {
  @ApiPropertyOptional({ enum: ['EMAIL', 'WHATSAPP'], description: 'Canal do código (padrão: o mesmo do link)' })
  @IsOptional()
  @IsIn(['EMAIL', 'WHATSAPP'])
  channel?: 'EMAIL' | 'WHATSAPP';
}

class VerifyOtpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 12)
  code: string;
}

class SignDto {
  @ApiProperty({ description: 'Manifestação explícita de vontade (obrigatória)' })
  @IsBoolean()
  consentAccepted: boolean;

  @ApiProperty({ example: '1.0' })
  @IsString()
  @MaxLength(20)
  consentVersion: string;

  @ApiProperty({ enum: SignatureMethod })
  @IsEnum(SignatureMethod)
  method: SignatureMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  typedName?: string;

  @ApiPropertyOptional({ description: 'data:image/png;base64,...' })
  @IsOptional()
  @IsString()
  @MaxLength(600_000)
  imageDataUrl?: string;

  @ApiPropertyOptional({ description: 'Mapa envelopeDocumentId → SHA-256 exibido ao signatário' })
  @IsOptional()
  @IsObject()
  documentHashes?: Record<string, string>;
}

class DeclineDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class ContentQuery {
  @ApiPropertyOptional({ enum: ['view', 'download'] })
  @IsOptional()
  @IsIn(['view', 'download'])
  mode?: 'view' | 'download';
}

type CookieRequest = Request & { cookies?: Record<string, string> };

/** Fluxo público do signatário. A sessão é restrita ao processo (cookie com path /api/v1/sign). */
@ApiTags('signing')
@Public()
@Controller('sign')
export class SigningController {
  constructor(
    private readonly signing: SigningService,
    private readonly otp: OtpService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private cookie(req: CookieRequest): string | undefined {
    return req.cookies?.[SIGN_SESSION_COOKIE];
  }

  @RateLimit('sign_open')
  @HttpCode(200)
  @Post('sessions')
  @ApiOperation({ summary: 'Valida o token do convite e inicia sessão de assinatura' })
  async open(@Body() dto: OpenSessionDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { sessionToken, ttlMs, state } = await this.signing.openSession(dto.token, clientInfo(req));
    res.cookie(SIGN_SESSION_COOKIE, sessionToken, cookieOptions(this.config, SIGN_PATH, ttlMs));
    res.setHeader('Cache-Control', 'no-store');
    return state;
  }

  @RateLimit('sign_open')
  @Get('session')
  async state(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.signing.state(await this.signing.resolve(this.cookie(req)));
  }

  @RateLimit('otp_request_ip')
  @HttpCode(202)
  @Post('otp/request')
  async requestOtp(@Body() dto: RequestOtpDto, @Req() req: CookieRequest) {
    const r = await this.signing.resolve(this.cookie(req));
    return this.otp.request(r.session, r.signer, clientInfo(req), dto.channel);
  }

  @RateLimit('otp_verify')
  @HttpCode(200)
  @Post('otp/verify')
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: CookieRequest) {
    const r = await this.signing.resolve(this.cookie(req));
    await this.otp.verify(r.session, r.signer, dto.code, clientInfo(req));
    return this.signing.state(await this.signing.resolve(this.cookie(req)));
  }

  @RateLimit('sign_open')
  @Get('documents/:envelopeDocumentId/content')
  async content(@Param('envelopeDocumentId', ParseUUIDPipe) id: string, @Query() q: ContentQuery, @Req() req: CookieRequest) {
    const r = await this.signing.resolve(this.cookie(req));
    const mode = q.mode ?? 'view';
    const file = await this.signing.openDocument(r, id, mode, clientInfo(req));
    return new StreamableFile(file.stream, {
      type: 'application/pdf',
      disposition: contentDisposition(mode === 'download' ? 'attachment' : 'inline', file.filename),
    });
  }

  @RateLimit('sign_open')
  @Get('evidence')
  async evidence(@Req() req: CookieRequest) {
    const r = await this.signing.resolve(this.cookie(req));
    const file = await this.signing.openEvidence(r, clientInfo(req));
    return new StreamableFile(file.stream, { type: 'application/pdf', disposition: contentDisposition('attachment', file.filename) });
  }

  @RateLimit('sign')
  @HttpCode(200)
  @Post('sign')
  @ApiOperation({ summary: 'Registra a assinatura (idempotente por signatário)' })
  async sign(@Body() dto: SignDto, @Req() req: CookieRequest) {
    const r = await this.signing.resolve(this.cookie(req));
    const result = await this.signing.sign(r, dto, clientInfo(req));
    return { ...result, state: await this.signing.state(await this.signing.resolve(this.cookie(req))) };
  }

  @RateLimit('sign')
  @HttpCode(200)
  @Post('decline')
  async decline(@Body() dto: DeclineDto, @Req() req: CookieRequest) {
    const r = await this.signing.resolve(this.cookie(req));
    await this.signing.decline(r, dto.reason, clientInfo(req));
    return { ok: true };
  }

  @HttpCode(200)
  @Post('session/end')
  async end(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response) {
    const token = this.cookie(req);
    if (token) {
      const r = await this.signing.resolve(token).catch(() => null);
      if (r) await this.signing.endSession(r);
    }
    res.clearCookie(SIGN_SESSION_COOKIE, { ...cookieOptions(this.config, SIGN_PATH, 0), maxAge: undefined });
    return { ok: true };
  }
}
