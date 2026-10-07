import { PlatformMode } from '@prisma/client';
import { ConnectorRegistryService } from './connector-registry.service';
import { SocialPublisher } from './social-publisher.interface';

function connector(platform: string): SocialPublisher {
  return {
    platform,
    mode: PlatformMode.OFFICIAL_API,
    capability: { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false },
    validate: () => Promise.resolve(),
    publish: () => Promise.resolve({ externalId: '1', status: 'PUBLISHED' }),
  };
}

describe('ConnectorRegistryService', () => {
  it('resolves connectors case-insensitively and exposes capabilities', () => {
    const registry = new ConnectorRegistryService();
    registry.register(connector('wordpress'));
    expect(registry.get('WordPress').platform).toBe('wordpress');
    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.platform).toBe('wordpress');
    expect(listed[0]?.capability.text).toBe(true);
  });

  it('rejects duplicate registrations', () => {
    const registry = new ConnectorRegistryService();
    registry.register(connector('x'));
    expect(() => registry.register(connector('X'))).toThrow("already registered");
  });

  it('maps an unknown platform to CONNECTOR_NOT_FOUND', () => {
    const registry = new ConnectorRegistryService();
    expect(() => registry.get('unknown')).toThrow("No connector is registered");
  });
});
