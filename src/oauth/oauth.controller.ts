import { BadRequestException, Controller, Get, Logger, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { OAuthService } from './oauth.service';
import { MetaTokenService } from '../credentials/meta-token.service';
import { ApplicationException } from '../common/exceptions/application.exception';
import { ApiOkEnvelope, OAuthProviderContractDto, OAuthStartContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('oauth')
@ApiBearerAuth()
@Controller('oauth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private readonly oauth: OAuthService,
    private readonly config: ConfigService,
    private readonly meta: MetaTokenService,
  ) {}

  @Get('providers')
  @ApiOkEnvelope(OAuthProviderContractDto, true)
  providers() {
    const linkedinReady = this.configured('LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET')
      && /^\d{6}$/.test(this.config.get<string>('LINKEDIN_API_VERSION') ?? '');
    const googleReady = this.configured('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
    return [
      { provider: 'linkedin', platform: 'linkedin', status: linkedinReady ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/linkedin/callback' },
      { provider: 'google', platform: 'blogger', status: googleReady ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/google/callback' },
      { provider: 'tumblr', platform: 'tumblr', status: this.configured('TUMBLR_CLIENT_ID', 'TUMBLR_CLIENT_SECRET') ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/tumblr/callback' },
      { provider: 'instagram', platform: 'instagram', status: this.meta.isConfigured('instagram') ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/instagram/callback' },
      { provider: 'threads', platform: 'threads', status: this.meta.isConfigured('threads') ? 'READY' : 'CREDENTIAL_REQUIRED', callback: '/api/v1/oauth/threads/callback' },
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
  @ApiResponse({ status: 303, description: 'OAuth finished; redirects to the frontend accounts page with oauth=success or oauth=error' })
  async callback(
    @Param('provider') provider: string,
    @Query('state') state: string,
    @Query('code') code: string,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    // The browser lands here directly from the provider, so failures must lead
    // back to the UI instead of rendering a raw JSON error on the API origin.
    if (error || !state || !code) {
      this.redirect(response, { oauth: 'error', provider, reason: error === 'access_denied' ? 'denied' : 'invalid_callback' });
      return;
    }
    try {
      const result = await this.oauth.callback(provider, state, code);
      this.redirect(response, { oauth: 'success', provider: result.provider, accounts: String(result.accountIds.length) });
    } catch (failure) {
      const reason = failure instanceof ApplicationException
        ? failure.code
        : failure instanceof BadRequestException ? 'INVALID_STATE' : 'UNEXPECTED';
      this.logger.warn(`OAuth callback failed for ${provider}: ${reason}`);
      this.redirect(response, { oauth: 'error', provider, reason });
    }
  }

  private redirect(response: Response, query: Record<string, string>): void {
    const frontend = (this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').split(',')[0] ?? 'http://localhost:3000').replace(/\/$/, '');
    response.redirect(303, `${frontend}/accounts?${new URLSearchParams(query).toString()}`);
  }

  private configured(...keys: string[]): boolean {
    return keys.every((key) => Boolean(this.config.get<string>(key)?.trim()));
  }
}
