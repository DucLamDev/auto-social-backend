import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ExtensionAgentController, ExtensionController } from './extension-agent.controller';
import { ExtensionAgentService } from './extension-agent.service';
import { ExtensionDeviceGuard } from './extension-device.guard';

@Module({
  imports: [CampaignsModule],
  controllers: [ExtensionController, ExtensionAgentController],
  providers: [ExtensionAgentService, ExtensionDeviceGuard],
  exports: [ExtensionAgentService],
})
export class ExtensionAgentModule {}
