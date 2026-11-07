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
import { AiModule } from '../ai/ai.module';
import { QueueModule } from '../queue/queue.module';
import { ExtensionUiRecoveryService } from './ui-recovery/ui-recovery.service';
import { ExtensionAuthHintService } from './ui-recovery/auth-hint.service';
import { ExtensionSelectorSuggestionService } from './ui-recovery/selector-suggestion.service';
import { ExtensionFormFillService } from './ui-recovery/form-fill.service';

@Module({
  imports: [CampaignsModule, StorageModule, AiModule, QueueModule],
  controllers: [ExtensionController, ExtensionAgentController, ExtensionLoginCheckController, ExtensionLoginCheckAgentController, AccountImportController],
  providers: [ExtensionAgentService, ExtensionDeviceGuard, ExtensionAccountSessionService, ExtensionLoginCheckService, AccountImportService, ExtensionUiRecoveryService, ExtensionSelectorSuggestionService, ExtensionFormFillService, ExtensionAuthHintService],
  exports: [ExtensionAgentService, ExtensionLoginCheckService, ExtensionSelectorSuggestionService],
})
export class ExtensionAgentModule {}
