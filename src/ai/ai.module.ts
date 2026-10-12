import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiContentService } from './ai-content.service';

@Module({ controllers: [AiController], providers: [AiContentService], exports: [AiContentService] })
export class AiModule {}
