import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { AiContentService } from './ai-content.service';
import { AiController } from './ai.controller';
import { AiImageService } from './ai-image.service';

describe('AiController roles', () => {
  const descriptor = {
    reviewer: { provider: 'vpsttt', model: 'claude:sonnet', label: 'Claude Sonnet', configured: true },
    approver: { provider: 'vpsttt', model: 'claude:opus', label: 'Claude Opus', configured: false },
    approvalEnabled: true,
  };

  it('serves GET /ai/roles from the service, signed in like GET /ai/providers', async () => {
    const roles = jest.fn().mockResolvedValue(descriptor);
    const controller = new AiController({ roles } as unknown as AiContentService, {} as AiImageService);

    await expect(controller.roles()).resolves.toEqual(descriptor);
    const handler = Object.getOwnPropertyDescriptor(AiController.prototype, 'roles')!.value as object;
    const providers = Object.getOwnPropertyDescriptor(AiController.prototype, 'providers')!.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, AiController)).toBe('ai');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('roles');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    // Same access as the provider list: any signed-in user, never public.
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(Reflect.getMetadata(ROLES_KEY, providers));
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
  });
});
