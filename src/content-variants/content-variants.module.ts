import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { MediaModule } from '../media/media.module';
import { ContentVariantsController } from './content-variants.controller';
import { ContentVariantsService } from './content-variants.service';
import { VariantApprovalService } from './variant-approval.service';
import { VariantImageService } from './variant-image.service';
import { VariantRewriteService } from './variant-rewrite.service';

@Module({ imports: [AiModule, MediaModule], controllers: [ContentVariantsController], providers: [ContentVariantsService, VariantImageService, VariantRewriteService, VariantApprovalService] })
export class ContentVariantsModule {}
