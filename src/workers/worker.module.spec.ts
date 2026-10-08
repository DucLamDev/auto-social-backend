import { Test } from '@nestjs/testing';
import { CampaignAutomationService } from '../campaigns/campaign-automation.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule dependency graph', () => {
  it('resolves campaign automation dependencies in the worker process', async () => {
    const previous = process.env.SKIP_INFRA_CONNECT;
    process.env.SKIP_INFRA_CONNECT = 'true';

    try {
      const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      expect(moduleRef.get(CampaignAutomationService)).toBeDefined();
      await moduleRef.close();
    } finally {
      if (previous === undefined) delete process.env.SKIP_INFRA_CONNECT;
      else process.env.SKIP_INFRA_CONNECT = previous;
    }
  });
});
