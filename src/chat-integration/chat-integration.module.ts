import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ChatApiClient } from './chat-api.client';
import { ChatDispatcherService } from './chat-dispatcher.service';
import { ChatEventsService } from './chat-events.service';
import { ChatEventsController, ChatIntegrationSettingsController } from './chat-integration.controller';
import { ChatNotifierService } from './chat-notifier.service';
import { ChatOutboxModule } from './chat-outbox.module';
import { ChatWebhookGuard } from './chat-webhook.guard';

@Module({
  imports: [ChatOutboxModule, CampaignsModule],
  controllers: [ChatIntegrationSettingsController, ChatEventsController],
  providers: [
    { provide: ChatApiClient, useFactory: () => new ChatApiClient() },
    ChatDispatcherService,
    ChatNotifierService,
    ChatEventsService,
    ChatWebhookGuard,
  ],
})
export class ChatIntegrationModule {}
