import { Body, Controller, Get, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from './auth.types';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ApiCreatedEnvelope, ApiOkEnvelope, AuthSessionContractDto, MutationResultContractDto, UserContractDto } from '../common/swagger/api-contract.dto';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { sha256 } from '../common/utils/crypto.utils';
import { RedisService } from '../queue/redis.service';

const AUTH_RATE_WINDOW_SECONDS = 15 * 60;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Post('login')
  @ApiCreatedEnvelope(AuthSessionContractDto)
  @ApiOperation({ summary: 'Authenticate and create a rotating refresh session' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.assertLoginRateLimit(this.clientIp(request), dto.email);
    const result = await this.auth.login(dto.email, dto.password, this.requestMetadata(request));
    this.setRefreshCookie(response, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('refresh')
  @ApiCreatedEnvelope(AuthSessionContractDto)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.assertRateLimit(`refresh:ip:${sha256(this.clientIp(request)).slice(0, 24)}`, 180);
    const token = dto.refreshToken ?? this.readRefreshCookie(request);
    if (typeof token !== 'string') throw new UnauthorizedException('Refresh token is required');
    const result = await this.auth.refresh(token, this.requestMetadata(request));
    this.setRefreshCookie(response, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Post('logout')
  @ApiCreatedEnvelope(MutationResultContractDto)
  @ApiBearerAuth()
  async logout(
    @Body() dto: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cookie = this.readRefreshCookie(request);
    await this.auth.logout(dto.refreshToken ?? cookie);
    response.clearCookie('refresh_token', { path: '/api/v1/auth' });
    return { loggedOut: true };
  }

  @Get('me')
  @ApiOkEnvelope(UserContractDto)
  @ApiBearerAuth()
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  private requestMetadata(request: Request) {
    return { userAgent: request.get('user-agent'), ipAddress: request.ip };
  }

  private clientIp(request: Request): string {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }

  private async assertLoginRateLimit(ipAddress: string, email: string): Promise<void> {
    const ip = sha256(ipAddress).slice(0, 24);
    const normalizedEmail = sha256(email.trim().toLowerCase()).slice(0, 24);
    await this.assertRateLimit(`login:ip:${ip}`, 100);
    await this.assertRateLimit(`login:email:${normalizedEmail}`, 10);
  }

  private async assertRateLimit(key: string, limit: number): Promise<void> {
    const result = await this.redis.consumeRateLimit(
      `rate_limit:auth:${key}`,
      limit,
      AUTH_RATE_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      throw new ApplicationException(
        ErrorCode.AUTH_RATE_LIMITED,
        'Too many authentication attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private setRefreshCookie(response: Response, token: string): void {
    response.cookie('refresh_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  private readRefreshCookie(request: Request): string | undefined {
    const header = request.get('cookie');
    if (!header) return undefined;
    const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('refresh_token='));
    if (!match) return undefined;
    const encoded = match.slice('refresh_token='.length);
    try { return decodeURIComponent(encoded); } catch { return undefined; }
  }
}
