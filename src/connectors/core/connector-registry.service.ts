import { HttpStatus, Injectable } from '@nestjs/common';
import { ApplicationException, ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorDescriptor } from './connector.types';
import { SocialPublisher } from './social-publisher.interface';

@Injectable()
export class ConnectorRegistryService {
  private readonly connectors = new Map<string, SocialPublisher>();

  register(connector: SocialPublisher): void {
    const key = connector.platform.toLowerCase();
    if (this.connectors.has(key)) throw new Error(`Connector '${key}' is already registered`);
    this.connectors.set(key, connector);
  }

  has(platform: string): boolean {
    return this.connectors.has(platform.toLowerCase());
  }

  get(platform: string): SocialPublisher {
    const connector = this.connectors.get(platform.toLowerCase());
    if (!connector) {
      throw new ApplicationException(
        ErrorCode.CONNECTOR_NOT_FOUND,
        `No connector is registered for '${platform}'`,
        HttpStatus.NOT_FOUND,
      );
    }
    return connector;
  }

  list(): ConnectorDescriptor[] {
    return [...this.connectors.values()].map(({ platform, mode, capability }) => ({
      platform,
      mode,
      capability,
    }));
  }
}
