import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiContentService } from './ai-content.service';
import { AiImageService } from './ai-image.service';
import { BrandProfileService } from './brand-profile.service';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
import { GeminiKeysController } from './gemini-keys.controller';

@Module({ controllers: [AiController, GeminiKeysController], providers: [AiContentService, AiImageService, BrandProfileService, GeminiKeyPoolService], exports: [AiContentService, AiImageService] })
export class AiModule {}
