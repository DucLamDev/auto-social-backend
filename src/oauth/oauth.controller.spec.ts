import { BadRequestException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { MetaTokenService } from '../credentials/meta-token.service';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

function controllerWith(values: Record<string, string>, oauth = {} as OAuthService): OAuthController {
  const config = new ConfigService(values);
  return new OAuthController(oauth, config, new MetaTokenService(config));
}

function fakeResponse() {
  const redirect = jest.fn();
  return { response: { redirect } as unknown as Response, redirect };
}

describe('OAuthController provider readiness', () => {
  it('does not advertise OAuth as ready when required application settings are missing', () => {
    expect(controllerWith({}).providers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'linkedin', status: 'CREDENTIAL_REQUIRED' }),
      expect.objectContaining({ provider: 'google', status: 'CREDENTIAL_REQUIRED' }),
      expect.objectContaining({ provider: 'instagram', status: 'CREDENTIAL_REQUIRED' }),
      expect.objectContaining({ provider: 'threads', status: 'CREDENTIAL_REQUIRED' }),
    ]));
  });

  it('advertises configured and versioned providers as ready', () => {
    const controller = controllerWith({
      LINKEDIN_CLIENT_ID: 'id', LINKEDIN_CLIENT_SECRET: 'secret', LINKEDIN_API_VERSION: '202610',
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
      INSTAGRAM_APP_ID: 'ig', INSTAGRAM_APP_SECRET: 'ig-secret',
      THREADS_APP_ID: 'th', THREADS_APP_SECRET: 'th-secret',
    });
    expect(controller.providers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'linkedin', status: 'READY' }),
      expect.objectContaining({ provider: 'google', status: 'READY' }),
      expect.objectContaining({ provider: 'instagram', platform: 'instagram', status: 'READY' }),
      expect.objectContaining({ provider: 'threads', platform: 'threads', status: 'READY' }),
    ]));
  });
});

describe('OAuthController callback redirects', () => {
  const frontend = { FRONTEND_URL: 'https://app.example.com' };

  it('returns to the accounts page with the number of linked accounts on success', async () => {
    const oauth = { callback: jest.fn().mockResolvedValue({ provider: 'threads', accountIds: ['a'] }) } as unknown as OAuthService;
    const { response, redirect } = fakeResponse();
    await controllerWith(frontend, oauth).callback('threads', 'state', 'code', undefined, response);
    expect(redirect).toHaveBeenCalledWith(303, 'https://app.example.com/accounts?oauth=success&provider=threads&accounts=1');
  });

  it('sends a denied consent screen back to the UI instead of a JSON error', async () => {
    const callback = jest.fn();
    const { response, redirect } = fakeResponse();
    await controllerWith(frontend, { callback } as unknown as OAuthService).callback('instagram', '', '', 'access_denied', response);
    expect(callback).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(303, 'https://app.example.com/accounts?oauth=error&provider=instagram&reason=denied');
  });

  it('maps exchange and state failures to stable reason codes', async () => {
    const { response, redirect } = fakeResponse();
    const failing = (error: Error) => ({ callback: jest.fn().mockRejectedValue(error) } as unknown as OAuthService);
    await controllerWith(frontend, failing(new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'x', HttpStatus.BAD_GATEWAY)))
      .callback('threads', 'state', 'code', undefined, response);
    await controllerWith(frontend, failing(new BadRequestException('expired state')))
      .callback('threads', 'state', 'code', undefined, response);
    expect(redirect.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      `https://app.example.com/accounts?oauth=error&provider=threads&reason=${ErrorCode.PLATFORM_AUTH_FAILED}`,
      'https://app.example.com/accounts?oauth=error&provider=threads&reason=INVALID_STATE',
    ]);
  });
});
