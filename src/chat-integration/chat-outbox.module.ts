import { Module } from '@nestjs/common';
import { ChatConfigService } from './chat-config.service';
import { ChatOutboxService } from './chat-outbox.service';

/** What the review flow needs to write chat events; no dependency back on campaigns. */
@Module({ providers: [ChatConfigService, ChatOutboxService], exports: [ChatConfigService, ChatOutboxService] })
export class ChatOutboxModule {}
