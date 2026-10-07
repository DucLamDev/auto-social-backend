import { Module } from '@nestjs/common';
import { AiContentService } from './ai-content.service';

@Module({ providers: [AiContentService], exports: [AiContentService] })
export class AiModule {}
