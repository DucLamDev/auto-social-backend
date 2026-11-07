import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentDevice, ExtensionDeviceGuard } from './extension-device.guard';
import { AuthenticatedDevice } from './extension-agent.service';
import { ExtensionAuthStepDto } from './extension-agent.dto';
import { ExtensionLoginCheckService } from './extension-login-check.service';
import { ExtensionAuthHintService } from './ui-recovery/auth-hint.service';
import { AuthHintConfirmDto, AuthHintRequestDto } from './ui-recovery/ui-hint.dto';

class QueueChecksDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) accountIds?: string[];
  @IsOptional() @IsBoolean() verifyOnly?: boolean;
  @IsOptional() @IsBoolean() tryBoth?: boolean;
  /** Bulk runs: leave out accounts whose latest login check succeeded. */
  @IsOptional() @IsBoolean() skipAuthenticated?: boolean;
}
class ClaimChecksDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200)
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] }, { each: true })
  @MaxLength(2048, { each: true }) allowedOrigins?: string[];
}
class LoginResultDto {
  @IsIn(['AUTHENTICATED', 'NEEDS_ACTION', 'FAILED']) outcome!: string;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
  @IsOptional() @IsString() @MaxLength(200) detectedUsername?: string;
  @IsOptional() @IsBoolean() googleBlocked?: boolean;
}
@Controller('extension/login-checks')
export class ExtensionLoginCheckController {
  constructor(private readonly checks: ExtensionLoginCheckService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.checks.list(user.id); }
  @Post() @Roles(RoleName.ADMIN)
  queue(@CurrentUser() user: AuthenticatedUser, @Body() dto: QueueChecksDto) { return this.checks.queue(user.id, dto.accountIds, dto.verifyOnly, dto.tryBoth, dto.skipAuthenticated); }
}
@Public() @UseGuards(ExtensionDeviceGuard) @Controller('extension/agent/login-checks')
export class ExtensionLoginCheckAgentController {
  constructor(private readonly checks: ExtensionLoginCheckService, private readonly authHints: ExtensionAuthHintService) {}
  @Get('status') status(@CurrentDevice() device: AuthenticatedDevice) { return this.checks.deviceStatus(device); }
  @Post('claim') async claim(@CurrentDevice() device: AuthenticatedDevice, @Body() dto: ClaimChecksDto) { return { task: await this.checks.claim(device, dto.allowedOrigins) }; }
  @Post(':id/auth') @Header('Cache-Control', 'no-store')
  auth(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionAuthStepDto) { return this.checks.authStep(device, id, dto); }
  @Post(':id/result') result(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LoginResultDto) { return this.checks.result(device, id, dto); }
  // AI sign-in hints for a "Test" check, like those of a publish job.
  @Post(':id/auth-hint') @HttpCode(HttpStatus.OK)
  authHint(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AuthHintRequestDto) { return this.authHints.request(device, { kind: 'login-check', id }, dto); }
  @Get(':id/auth-hint/:hintId')
  authHintStatus(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Param('hintId', ParseUUIDPipe) hintId: string) { return this.authHints.get(device, { kind: 'login-check', id }, hintId); }
  @Post(':id/auth-hint/:hintId/confirm') @HttpCode(HttpStatus.OK)
  authHintConfirm(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Param('hintId', ParseUUIDPipe) hintId: string, @Body() dto: AuthHintConfirmDto) {
    return this.authHints.confirm(device, { kind: 'login-check', id }, hintId, dto.selector);
  }
}
