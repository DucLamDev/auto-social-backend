import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderThrottle } from './provider-throttle';

/**
 * The IDE AI API counts every call of a user and of a key together, text and
 * images alike (VPSTTT_AI_MAX_CONCURRENCY in flight, VPSTTT_AI_RPM starts a
 * minute; IDE defaults 2 and 10). Writing and image services share this one
 * throttle so a campaign writing posts while images are drawn stays inside the
 * limit. One start a minute is left free for network jitter at the boundary.
 */
@Injectable()
export class VpstttQuota {
  readonly throttle: ProviderThrottle;

  constructor(config: ConfigService) {
    const concurrency = Math.max(1, Number(config.get<number>('VPSTTT_AI_MAX_CONCURRENCY', 2)) || 2);
    const perMinute = Math.max(1, Number(config.get<number>('VPSTTT_AI_RPM', 10)) || 10);
    this.throttle = new ProviderThrottle(concurrency, perMinute > 1 ? perMinute - 1 : 1);
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return this.throttle.run(task);
  }
}
