import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ExtensionAgentController, ExtensionController } from './extension-agent.controller';
import { ExtensionAgentService } from './extension-agent.service';
import { ExtensionDeviceGuard } from './extension-device.guard';
import { StorageModule } from '../storage/storage.module';
import { ExtensionAccountSessionService } from './extension-account-session.service';
import { ExtensionLoginCheckService } from './extension-login-check.service';
import { ExtensionLoginCheckController, ExtensionLoginCheckAgentController } from './extension-login-check.controller';
import { AccountImportController } from './account-import.controller';
import { AccountImportService } from './account-import.service';

@Module({
  imports: [CampaignsModule, StorageModule],
  controllers: [ExtensionController, ExtensionAgentController, ExtensionLoginCheckController, ExtensionLoginCheckAgentController, AccountImportController],
  providers: [ExtensionAgentService, ExtensionDeviceGuard, ExtensionAccountSessionService, ExtensionLoginCheckService, AccountImportService],
  exports: [ExtensionAgentService],
})
export class ExtensionAgentModule {}
