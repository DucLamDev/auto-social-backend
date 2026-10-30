import { BadRequestException, Body, Controller, Header, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsEmail, IsOptional, IsUUID } from 'class-validator';
import { RoleName } from '@prisma/client';
import { extname } from 'node:path';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { AccountImportService, parseAccountUpload } from './account-import.service';

class ImportAccountsDto {
  @IsUUID('4') deviceId!: string;
  @IsOptional() @IsEmail() googleEmail?: string;
}

@Controller('extension/accounts/import')
export class AccountImportController {
  constructor(private readonly importer: AccountImportService) {}
  @Post() @Roles(RoleName.ADMIN) @Header('Cache-Control', 'no-store')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 2 } }))
  async upload(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file: Express.Multer.File, @Body() dto: ImportAccountsDto) {
    if (!file?.buffer) throw new BadRequestException('Chọn file tài khoản.');
    const rows = await parseAccountUpload(file.buffer, extname(file.originalname).slice(1).toLowerCase());
    return this.importer.import(user.id, dto.deviceId, rows, dto.googleEmail);
  }
}
