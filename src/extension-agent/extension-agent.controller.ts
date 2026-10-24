import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateExtensionDeviceDto, ExtensionDeliveryDto, ExtensionTaskResultDto } from './extension-agent.dto';
import { AuthenticatedDevice, ExtensionAgentService } from './extension-agent.service';
import { CurrentDevice, ExtensionDeviceGuard } from './extension-device.guard';

/** Operator side: pair Chrome extensions and switch accounts to extension delivery. */
@ApiTags('extension')
@ApiBearerAuth()
@Controller('extension')
export class ExtensionController {
  constructor(private readonly agent: ExtensionAgentService) {}

  @Get('devices')
  devices(@CurrentUser() user: AuthenticatedUser) {
    return this.agent.listDevices(user.id);
  }

  @Post('devices')
  @Roles(RoleName.ADMIN)
  @ApiOperation({ summary: 'Create a pairing token for one Chrome; the token is shown only in this response' })
  createDevice(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateExtensionDeviceDto) {
    return this.agent.createDevice(user.id, dto.name);
  }

  @Delete('devices/:id')
  @Roles(RoleName.ADMIN)
  revokeDevice(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.agent.revokeDevice(user.id, id);
  }

  @Put('accounts/:id')
  @Roles(RoleName.ADMIN)
  @ApiOperation({ summary: 'Turn Chrome extension delivery on/off for a forum account' })
  configureAccount(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionDeliveryDto) {
    return this.agent.configureAccount(user.id, id, dto);
  }

  @Post('jobs/:id/requeue')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  @ApiOperation({ summary: 'Operator confirmed nothing was posted: give the job back to the extension' })
  requeue(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.agent.requeue(user.id, id);
  }
}

/** Extension side, authenticated by the device token instead of a user session. */
@ApiTags('extension-agent')
@Public()
@UseGuards(ExtensionDeviceGuard)
@Controller('extension/agent')
export class ExtensionAgentController {
  constructor(private readonly agent: ExtensionAgentService) {}

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@CurrentDevice() device: AuthenticatedDevice) {
    return this.agent.heartbeat(device);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(@CurrentDevice() device: AuthenticatedDevice) {
    return { task: await this.agent.claim(device) };
  }

  @Post('tasks/:id/result')
  @HttpCode(HttpStatus.OK)
  report(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionTaskResultDto) {
    return this.agent.report(device, id, dto);
  }
}
