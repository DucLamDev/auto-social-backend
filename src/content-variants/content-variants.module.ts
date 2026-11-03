import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { MediaModule } from '../media/media.module';
import { ContentVariantsController } from './content-variants.controller';
import { ContentVariantsService } from './content-variants.service';
import { VariantImageService } from './variant-image.service';

@Module({ imports: [AiModule, MediaModule], controllers: [ContentVariantsController], providers: [ContentVariantsService, VariantImageService] })
export class ContentVariantsModule {}
