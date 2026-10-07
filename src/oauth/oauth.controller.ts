import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { OAuthService } from './oauth.service';
import { ApiOkEnvelope, OAuthProviderContractDto, OAuthStartContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('oauth')
@ApiBearerAuth()
@Controller('oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService, private readonly config: ConfigService) {}

  @Get('providers')
  @ApiOkEnvelope(OAuthProviderContractDto, true)
  providers() {
    const linkedinReady = this.configured('LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET')
      && /^\d{6}$/.test(this.config.get<string>('LINKEDIN_API_VERSION') ?? '');
    const googleReady = this.configured('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
    return [
      { provider: 'linkedin', platform: 'linkedin', status: linkedinReady ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/linkedin/callback' },
      { provider: 'google', platform: 'blogger', status: googleReady ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/google/callback' },
      { provider: 'instagram', status: 'API_REVIEW_REQUIRED' },
      { provider: 'threads', status: 'API_REVIEW_REQUIRED' },
      { provider: 'x', status: 'API_RESEARCH_REQUIRED' },
      { provider: 'reddit', status: 'MANUAL' },
      { provider: 'tiktok', status: 'API_REVIEW_REQUIRED' },
    ];
  }

  @Get(':provider/start')
  @ApiOkEnvelope(OAuthStartContractDto)
  @Roles(RoleName.ADMIN)
  start(@CurrentUser() user: AuthenticatedUser, @Param('provider') provider: string) {
    return this.oauth.start(user.id, provider);
  }

  @Public()
  @Get(':provider/callback')
  @ApiOperation({ security: [] })
  @ApiResponse({ status: 303, description: 'OAuth completed; redirects to the frontend accounts page' })
  async callback(
    @Param('provider') provider: string,
    @Query('state') state: string,
    @Query('code') code: string,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (error || !state || !code) throw new BadRequestException('OAuth authorization was denied or callback parameters are missing');
    const result = await this.oauth.callback(provider, state, code);
    const frontend = (this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').split(',')[0] ?? 'http://localhost:3000').replace(/\/$/, '');
    response.redirect(303, `${frontend}/accounts?oauth=success&provider=${encodeURIComponent(result.provider)}`);
  }

  private configured(...keys: string[]): boolean {
    return keys.every((key) => Boolean(this.config.get<string>(key)?.trim()));
  }
}
