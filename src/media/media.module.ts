import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaUploadConcurrencyInterceptor } from './media-upload-concurrency.interceptor';

@Module({ imports: [StorageModule], controllers: [MediaController], providers: [MediaService, MediaUploadConcurrencyInterceptor] })
export class MediaModule {}
