import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { CampaignsController } from './campaigns.controller';
import { CampaignAutomationService } from './campaign-automation.service';
import { CampaignsService } from './campaigns.service';
import { AuthenticatedUser } from '../auth/auth.types';

describe('Campaign restoration routes', () => {
  it('restricts both routes to editors/admins and forwards the authenticated owner', async () => {
    const automation = { restore: jest.fn() };
    const controller = new CampaignsController({} as CampaignsService, automation as unknown as CampaignAutomationService);
    // Metadata inspection intentionally uses the original methods without invoking them.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    for (const method of [controller.restore, controller.restoreVariant]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([RoleName.ADMIN, RoleName.EDITOR]);
    }
    const user = { id: 'owner' } as AuthenticatedUser;
    await controller.restore(user, 'campaign');
    expect(automation.restore).toHaveBeenLastCalledWith('owner', 'campaign');
    await controller.restoreVariant(user, 'campaign', 'variant');
    expect(automation.restore).toHaveBeenLastCalledWith('owner', 'campaign', 'variant');
  });
});
