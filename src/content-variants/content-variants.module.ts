import { Module } from '@nestjs/common';
import { ContentVariantsController } from './content-variants.controller';
import { ContentVariantsService } from './content-variants.service';

@Module({ controllers: [ContentVariantsController], providers: [ContentVariantsService] })
export class ContentVariantsModule {}
