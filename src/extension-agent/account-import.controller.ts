import { BadRequestException, Body, Controller, Header, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RoleName } from '@prisma/client';
import { extname } from 'node:path';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { AccountImportService, parseAccountUpload } from './account-import.service';

/** Fields of the removed "Google dùng chung" option, still sent by older dashboards. */
const REMOVED_SHARED_GOOGLE_FIELDS = ['googleEmail', 'googlePassword', 'googleTotpSecret'] as const;

export const SHARED_GOOGLE_REMOVED_MESSAGE = 'Ô "Google dùng chung" đã được bỏ: mỗi dòng trong file đăng nhập bằng email, mật khẩu và 2FA của '
  + 'chính dòng đó. Xoá trống 3 ô Google dùng chung rồi nhập lại, hoặc tải lại trang (Ctrl+F5) sau khi cập nhật giao diện web lên bản 1.4.1.';

class ImportAccountsDto {
  @IsUUID('4') deviceId!: string;
  // Accepted only to answer older dashboards with a clear message instead of
  // "Too many fields"; never stored or used.
  @IsOptional() @IsString() @MaxLength(1024) googleEmail?: string;
  @IsOptional() @IsString() @MaxLength(1024) googlePassword?: string;
  @IsOptional() @IsString() @MaxLength(1024) googleTotpSecret?: string;
}

@Controller('extension/accounts/import')
export class AccountImportController {
  constructor(private readonly importer: AccountImportService) {}
  @Post() @Roles(RoleName.ADMIN) @Header('Cache-Control', 'no-store')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 1 + REMOVED_SHARED_GOOGLE_FIELDS.length } }))
  async upload(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file: Express.Multer.File, @Body() dto: ImportAccountsDto) {
    if (REMOVED_SHARED_GOOGLE_FIELDS.some(field => dto[field]?.trim())) throw new BadRequestException(SHARED_GOOGLE_REMOVED_MESSAGE);
    if (!file?.buffer) throw new BadRequestException('Chọn file tài khoản.');
    const rows = await parseAccountUpload(file.buffer, extname(file.originalname).slice(1).toLowerCase());
    return this.importer.import(user.id, dto.deviceId, rows);
  }
}
