import { Module } from '@nestjs/common';
import { ContentsController } from './contents.controller';
import { ContentsService } from './contents.service';
import { AiModule } from '../ai/ai.module';

@Module({ imports: [AiModule], controllers: [ContentsController], providers: [ContentsService], exports: [ContentsService] })
export class ContentsModule {}
