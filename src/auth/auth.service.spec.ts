import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RoleName } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from './auth.service';
import { sha256 } from '../common/utils/crypto.utils';

describe('AuthService', () => {
  it('issues access/refresh tokens and stores only the refresh hash', async () => {
    const passwordHash = await hash('CorrectPassword123!', 4);
    const createSession: jest.MockedFunction<
      (input: { data: { tokenHash: string } }) => Promise<object>
    > = jest.fn();
    createSession.mockResolvedValue({});
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: '47d76e8d-aeb6-4fb3-97b7-12f917828983',
          email: 'admin@example.com',
          displayName: 'Admin',
          enabled: true,
          passwordHash,
          roles: [{ role: { name: RoleName.ADMIN } }],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      refreshTokenSession: { create: createSession },
    };
    const service = new AuthService(
      prismaMock as unknown as PrismaService,
      new JwtService(),
      new ConfigService({
        JWT_ACCESS_SECRET: 'access-secret-with-at-least-32-characters',
        JWT_REFRESH_SECRET: 'refresh-secret-with-at-least-32-characters',
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_TTL: '30d',
      }),
    );
    const result = await service.login('ADMIN@example.com', 'CorrectPassword123!', {});
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    const createCall = createSession.mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    if (!createCall) throw new Error('Expected refresh session creation');
    expect(createCall.data.tokenHash).not.toBe(result.refreshToken);
    expect(createCall.data.tokenHash).toHaveLength(64);
  });

  it('returns the same public error for unknown users', async () => {
    const prismaMock = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new AuthService(
      prismaMock as unknown as PrismaService,
      new JwtService(),
      new ConfigService({}),
    );
    await expect(service.login('missing@example.com', 'WrongPassword!', {})).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
  });

  it('atomically rotates a refresh session so token reuse cannot issue another session', async () => {
    const jwt = new JwtService();
    const refreshSecret = 'refresh-secret-with-at-least-32-characters';
    const token = await jwt.signAsync(
      { sub: 'user-1', sid: 'session-1', type: 'refresh' },
      { secret: refreshSecret, expiresIn: '1h' },
    );
    const session = {
      id: 'session-1',
      tokenHash: sha256(token),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1', email: 'user@example.com', displayName: 'User', enabled: true,
        roles: [{ role: { name: RoleName.EDITOR } }],
      },
    };
    const updateMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma = {
      refreshTokenSession: {
        findUnique: jest.fn().mockResolvedValue(session),
        updateMany,
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const service = new AuthService(prisma, jwt, new ConfigService({
      JWT_ACCESS_SECRET: 'access-secret-with-at-least-32-characters',
      JWT_REFRESH_SECRET: refreshSecret,
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '30d',
    }));

    await expect(service.refresh(token, {})).resolves.toMatchObject({ user: { id: 'user-1' } });
    await expect(service.refresh(token, {})).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });
});
