import { BadRequestException, Body, Controller, Header, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { RoleName } from '@prisma/client';
import { extname } from 'node:path';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { AccountImportRow, AccountImportService, parseAccountUpload } from './account-import.service';

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

/** One social added by hand: the same fields as one row of the accounts file. */
export class ImportOneAccountDto {
  @ApiProperty({ format: 'uuid', description: 'Paired Chrome that signs in and posts for this account.' }) @IsUUID('4') deviceId!: string;
  @ApiProperty({ description: 'Platform slug, e.g. daily-dev.' }) @IsString() @Matches(/^[a-z0-9-]{2,80}$/) platform!: string;
  @ApiProperty({ enum: ['password', 'google'] }) @IsIn(['password', 'google']) provider!: 'password' | 'google';
  @ApiProperty({ description: 'Email or username used to sign in.' }) @IsString() @MinLength(1) @MaxLength(320) loginUsername!: string;
  @ApiPropertyOptional({ description: 'Password of the platform, or of the Google account for Google sign-in.' }) @IsOptional() @IsString() @MaxLength(512) password?: string;
  @ApiPropertyOptional({ description: 'Authenticator setup key (not a 6-digit code).' }) @IsOptional() @IsString() @MaxLength(256) totpSecret?: string;
  @ApiPropertyOptional({ description: 'Handle on the platform; found after the first login when omitted.' }) @IsOptional() @IsString() @MaxLength(80) expectedUsername?: string;
  @ApiPropertyOptional({ description: 'Own profile page on the platform.' }) @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https'] }) @MaxLength(2048) profileUrl?: string;
  @ApiPropertyOptional({ description: 'New-post page; the flow default is used when omitted.' }) @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https'] }) @MaxLength(2048) targetUrl?: string;
  @ApiPropertyOptional({ description: 'Forum category or community, when the flow needs one.' }) @IsOptional() @IsString() @MaxLength(200) category?: string;
  @ApiPropertyOptional({ description: 'Comma-separated fixed tags.' }) @IsOptional() @IsString() @MaxLength(500) tags?: string;
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

  /** Adds (or updates) one social through the same rules as a file row: only it is signed in. */
  @Post('one') @Roles(RoleName.ADMIN) @Header('Cache-Control', 'no-store')
  async one(@CurrentUser() user: AuthenticatedUser, @Body() dto: ImportOneAccountDto) {
    const row: AccountImportRow = {
      source: 'manual:1', platform: dto.platform, label: dto.platform, provider: dto.provider,
      loginUsername: dto.loginUsername.trim(), password: dto.password ?? '', totpSecret: (dto.totpSecret ?? '').replace(/\s+/g, ''),
      profileUrl: dto.profileUrl?.trim() ?? '', expectedUsername: dto.expectedUsername?.trim().replace(/^@/, '') ?? '',
      targetUrl: dto.targetUrl?.trim(), tags: dto.tags, category: dto.category?.trim(),
    };
    return this.importer.import(user.id, dto.deviceId, [row]);
  }
}
