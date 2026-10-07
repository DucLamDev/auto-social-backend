import type { Request, Response } from 'express';
import { RedisService } from '../queue/redis.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController rate limiting', () => {
  it('blocks repeated login attempts before password verification', async () => {
    const login = jest.fn();
    const consumeRateLimit = jest.fn()
      .mockResolvedValueOnce({ allowed: true, remaining: 99 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const controller = new AuthController(
      { login } as unknown as AuthService,
      { consumeRateLimit } as unknown as RedisService,
    );
    const request = {
      ip: '203.0.113.10',
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as Request;
    const response = { cookie: jest.fn() } as unknown as Response;

    await expect(controller.login(
      { email: 'USER@example.com', password: 'WrongPassword123!' },
      request,
      response,
    )).rejects.toMatchObject({
      status: 429,
      response: expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }) as unknown,
    });
    expect(login).not.toHaveBeenCalled();
    expect(consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consumeRateLimit.mock.calls)).not.toContain('USER@example.com');
    expect(JSON.stringify(consumeRateLimit.mock.calls)).not.toContain('203.0.113.10');
  });
});
