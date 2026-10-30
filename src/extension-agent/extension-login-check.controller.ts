import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
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

class QueueChecksDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) accountIds?: string[];
  @IsOptional() @IsBoolean() verifyOnly?: boolean;
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
  queue(@CurrentUser() user: AuthenticatedUser, @Body() dto: QueueChecksDto) { return this.checks.queue(user.id, dto.accountIds, dto.verifyOnly); }
}
@Public() @UseGuards(ExtensionDeviceGuard) @Controller('extension/agent/login-checks')
export class ExtensionLoginCheckAgentController {
  constructor(private readonly checks: ExtensionLoginCheckService) {}
  @Get('status') status(@CurrentDevice() device: AuthenticatedDevice) { return this.checks.deviceStatus(device); }
  @Post('claim') async claim(@CurrentDevice() device: AuthenticatedDevice, @Body() dto: ClaimChecksDto) { return { task: await this.checks.claim(device, dto.allowedOrigins) }; }
  @Post(':id/auth') @Header('Cache-Control', 'no-store')
  auth(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionAuthStepDto) { return this.checks.authStep(device, id, dto); }
  @Post(':id/result') result(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LoginResultDto) { return this.checks.result(device, id, dto); }
}
