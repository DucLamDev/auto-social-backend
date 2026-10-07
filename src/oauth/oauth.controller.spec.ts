import { ConfigService } from '@nestjs/config';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

describe('OAuthController provider readiness', () => {
  it('does not advertise OAuth as ready when required application settings are missing', () => {
    const controller = new OAuthController({} as OAuthService, new ConfigService({}));
    expect(controller.providers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'linkedin', status: 'CREDENTIAL_REQUIRED' }),
      expect.objectContaining({ provider: 'google', status: 'CREDENTIAL_REQUIRED' }),
    ]));
  });

  it('advertises configured and versioned providers as ready', () => {
    const controller = new OAuthController({} as OAuthService, new ConfigService({
      LINKEDIN_CLIENT_ID: 'id', LINKEDIN_CLIENT_SECRET: 'secret', LINKEDIN_API_VERSION: '202610',
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    }));
    expect(controller.providers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'linkedin', status: 'READY' }),
      expect.objectContaining({ provider: 'google', status: 'READY' }),
    ]));
  });
});
