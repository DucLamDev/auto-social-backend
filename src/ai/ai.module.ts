import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiContentService } from './ai-content.service';
import { AiImageService } from './ai-image.service';
import { BrandProfileController } from './brand-profile.controller';
import { BrandProfileService } from './brand-profile.service';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
import { GeminiKeysController } from './gemini-keys.controller';
import { VpstttQuota } from './vpsttt-quota';

@Module({ controllers: [AiController, BrandProfileController, GeminiKeysController], providers: [AiContentService, AiImageService, BrandProfileService, GeminiKeyPoolService, VpstttQuota], exports: [AiContentService, AiImageService] })
export class AiModule {}
