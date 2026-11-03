import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ExtensionAgentModule } from '../extension-agent/extension-agent.module';
import { PlatformAccountsModule } from '../platform-accounts/platform-accounts.module';
import { PublishingModule } from '../publishing/publishing.module';
import { QueueModule } from '../queue/queue.module';
import { McpController } from './mcp.controller';
import { McpTokenGuard } from './mcp-token.guard';
import { McpTokenService } from './mcp-token.service';
import { McpToolsService } from './mcp-tools.service';

@Module({
  imports: [AiModule, CampaignsModule, ExtensionAgentModule, PlatformAccountsModule, PublishingModule, QueueModule],
  controllers: [McpController],
  providers: [McpTokenService, McpTokenGuard, McpToolsService],
  exports: [McpTokenService],
})
export class McpModule {}
