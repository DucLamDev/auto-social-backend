import { BadRequestException, Body, Controller, Get, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { MediaService } from './media.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ApiCreatedEnvelope, ApiOkEnvelope, MediaAssetContractDto } from '../common/swagger/api-contract.dto';
import { ListMediaQueryDto } from './dto/list-media-query.dto';
import { MediaUploadConcurrencyInterceptor } from './media-upload-concurrency.interceptor';
import { MEDIA_ALT_TEXT_MAX_LENGTH, UploadMediaDto } from './dto/upload-media.dto';

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  @ApiOkEnvelope(MediaAssetContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListMediaQueryDto) {
    return this.media.list(user.id, query);
  }

  @Post()
  @ApiCreatedEnvelope(MediaAssetContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  @UseInterceptors(MediaUploadConcurrencyInterceptor, FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        contentId: { type: 'string', format: 'uuid' },
        variantId: { type: 'string', format: 'uuid' },
        altText: {
          type: 'string',
          maxLength: MEDIA_ALT_TEXT_MAX_LENGTH,
          description: 'Accessible description stored with the media asset metadata.',
        },
      },
    },
  })
  upload(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file: Express.Multer.File, @Body() dto: UploadMediaDto) {
    if (!file) throw new BadRequestException('File is required');
    if (dto.contentId && dto.variantId) throw new BadRequestException('Choose either contentId or variantId, not both');
    return this.media.upload(user.id, file, dto.contentId, dto.variantId, dto.altText);
  }
}
