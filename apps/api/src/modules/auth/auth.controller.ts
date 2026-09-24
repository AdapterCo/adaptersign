import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { clientInfo } from '../../common/http/client-info';
import { CurrentAuth, Public, UserOnly } from '../../common/auth/decorators';
import type { AuthContext } from '../../common/auth/auth-context';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions } from '../../common/auth/tokens';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import { Errors } from '../../common/errors/app-error';
import { AuthService, type IssuedTokens } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SwitchOrganizationDto,
  VerifyEmailDto,
} from './auth.dto';

const REFRESH_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private setCookies(res: Response, tokens: IssuedTokens): void {
    res.cookie(ACCESS_COOKIE, tokens.accessToken, cookieOptions(this.config, '/', tokens.accessTtlMs));
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(this.config, REFRESH_PATH, tokens.refreshTtlMs));
  }

  private clearCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { ...cookieOptions(this.config, '/', 0), maxAge: undefined });
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(this.config, REFRESH_PATH, 0), maxAge: undefined });
  }

  @Public()
  @RateLimit('register')
  @Post('register')
  @ApiOperation({ summary: 'Cadastra empresa (organização) e usuário OWNER' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.register(dto, clientInfo(req));
    this.setCookies(res, tokens);
    return { ok: true };
  }

  @Public()
  @RateLimit('login')
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.login(dto.email, dto.password, clientInfo(req));
    this.setCookies(res, tokens);
    return { ok: true };
  }

  @Public()
  @RateLimit('refresh')
  @HttpCode(200)
  @Post('refresh')
  @ApiOperation({ summary: 'Rotaciona o refresh token (cookie) e emite novo access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    if (!raw) throw Errors.unauthenticated();
    try {
      const tokens = await this.auth.refresh(raw, clientInfo(req));
      this.setCookies(res, tokens);
      return { ok: true };
    } catch (err) {
      this.clearCookies(res);
      throw err;
    }
  }

  @ApiCookieAuth()
  @UserOnly()
  @HttpCode(200)
  @Post('logout')
  async logout(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth, clientInfo(req));
    this.clearCookies(res);
    return { ok: true };
  }

  @ApiCookieAuth()
  @UserOnly()
  @HttpCode(200)
  @Post('logout-all')
  @ApiOperation({ summary: 'Encerra todas as sessões do usuário' })
  async logoutAll(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    const count = await this.auth.revokeAllSessions(auth.userId, auth.organizationId, clientInfo(req), 'logout_all');
    this.clearCookies(res);
    return { revoked: count };
  }

  @ApiCookieAuth()
  @UserOnly()
  @Get('sessions')
  sessions(@CurrentAuth() auth: AuthContext) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    return this.auth.listSessions(auth.userId, auth.sessionId);
  }

  @ApiCookieAuth()
  @UserOnly()
  @Delete('sessions/:id')
  async revokeSession(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    await this.auth.revokeSession(auth.userId, id, auth.organizationId, clientInfo(req));
    return { ok: true };
  }

  @ApiCookieAuth()
  @UserOnly()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @ApiCookieAuth()
  @UserOnly()
  @HttpCode(200)
  @Post('switch-organization')
  async switchOrganization(@CurrentAuth() auth: AuthContext, @Body() dto: SwitchOrganizationDto, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.switchOrganization(auth, dto.organizationId);
    this.setCookies(res, tokens);
    return { ok: true };
  }

  @ApiCookieAuth()
  @UserOnly()
  @HttpCode(202)
  @Post('verify-email/request')
  async requestVerification(@CurrentAuth() auth: AuthContext, @Req() req: Request) {
    await this.auth.requestEmailVerification(auth, clientInfo(req));
    return { ok: true };
  }

  @Public()
  @RateLimit('password_reset')
  @HttpCode(200)
  @Post('verify-email/confirm')
  async confirmEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    await this.auth.confirmEmail(dto.token, clientInfo(req));
    return { ok: true };
  }

  @Public()
  @RateLimit('password_reset')
  @HttpCode(202)
  @Post('password/forgot')
  @ApiOperation({ summary: 'Solicita redefinição de senha (resposta idêntica exista ou não a conta)' })
  async forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, clientInfo(req));
    return { ok: true };
  }

  @Public()
  @RateLimit('password_reset')
  @HttpCode(200)
  @Post('password/reset')
  async reset(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.password, clientInfo(req));
    return { ok: true };
  }

  @ApiCookieAuth()
  @UserOnly()
  @HttpCode(200)
  @Post('password/change')
  async change(@CurrentAuth() auth: AuthContext, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(auth, dto.currentPassword, dto.newPassword, clientInfo(req));
    return { ok: true };
  }
}
