import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedDevice, ExtensionAgentService } from './extension-agent.service';

type DeviceRequest = Request & { extensionDevice?: AuthenticatedDevice };

/** Authenticates the Chrome extension by its device token (routes are otherwise @Public). */
@Injectable()
export class ExtensionDeviceGuard implements CanActivate {
  constructor(private readonly agent: ExtensionAgentService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    request.extensionDevice = await this.agent.authenticate(request.headers.authorization);
    return true;
  }
}

export const CurrentDevice = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedDevice => {
  const device = context.switchToHttp().getRequest<DeviceRequest>().extensionDevice;
  if (!device) throw new Error('ExtensionDeviceGuard must run before CurrentDevice');
  return device;
});
