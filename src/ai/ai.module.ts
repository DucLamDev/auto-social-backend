import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiContentService } from './ai-content.service';
import { BrandProfileService } from './brand-profile.service';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
import { GeminiKeysController } from './gemini-keys.controller';

@Module({ controllers: [AiController, GeminiKeysController], providers: [AiContentService, BrandProfileService, GeminiKeyPoolService], exports: [AiContentService] })
export class AiModule {}
