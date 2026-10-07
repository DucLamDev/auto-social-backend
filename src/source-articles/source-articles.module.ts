import { Module } from '@nestjs/common';
import { ContentsModule } from '../contents/contents.module';
import { SourceArticlesController } from './source-articles.controller';
import { SourceArticlesService } from './source-articles.service';

@Module({ imports: [ContentsModule], controllers: [SourceArticlesController], providers: [SourceArticlesService] })
export class SourceArticlesModule {}
