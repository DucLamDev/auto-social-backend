import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ClaimExtensionTaskDto, CreateExtensionDeviceDto, ExtensionDeliveryDto, ExtensionTaskResultDto, ExtensionSessionDto, ExtensionAuthStepDto } from './extension-agent.dto';
import { ExtensionAccountSessionService } from './extension-account-session.service';
import { AuthenticatedDevice, ExtensionAgentService } from './extension-agent.service';
import { CurrentDevice, ExtensionDeviceGuard } from './extension-device.guard';
import { ListSelectorSuggestionsQueryDto, UiHintRequestDto } from './ui-recovery/ui-hint.dto';
import { ExtensionUiRecoveryService } from './ui-recovery/ui-recovery.service';
import { ExtensionSelectorSuggestionService } from './ui-recovery/selector-suggestion.service';
import { FormFillRequestDto } from './ui-recovery/form-fill.dto';
import { ExtensionFormFillService } from './ui-recovery/form-fill.service';

/** Operator side: pair Chrome extensions and switch accounts to extension delivery. */
@ApiTags('extension')
@ApiBearerAuth()
@Controller('extension')
export class ExtensionController {
  constructor(
    private readonly agent: ExtensionAgentService,
    private readonly sessions: ExtensionAccountSessionService,
    private readonly suggestions: ExtensionSelectorSuggestionService,
  ) {}

  @Get('selector-suggestions')
  @ApiOperation({ summary: 'Selectors the AI proposed after a composer was not found; approved ones run with automatic submit' })
  selectorSuggestions(@CurrentUser() user: AuthenticatedUser, @Query() query: ListSelectorSuggestionsQueryDto) {
    return this.suggestions.list(user.id, query);
  }

  @Post('selector-suggestions/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  approveSelector(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.suggestions.approve(user.id, id, user.id);
  }

  @Post('selector-suggestions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  rejectSelector(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.suggestions.reject(user.id, id, user.id);
  }

  @Put('accounts/:id/session')
  @Roles(RoleName.ADMIN)
  @Header('Cache-Control', 'no-store')
  configureSession(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionSessionDto) {
    return this.sessions.configure(user.id, id, dto);
  }

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
  constructor(
    private readonly agent: ExtensionAgentService,
    private readonly sessions: ExtensionAccountSessionService,
    private readonly uiRecovery: ExtensionUiRecoveryService,
    private readonly formFill: ExtensionFormFillService,
  ) {}

  @Post('tasks/:id/ui-hint')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the AI which visible element is the missing composer control (answers within ~8 s or poll)' })
  uiHint(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UiHintRequestDto) {
    return this.uiRecovery.request(device, id, dto);
  }

  @Get('tasks/:id/ui-hint/:hintId')
  uiHintStatus(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Param('hintId', ParseUUIDPipe) hintId: string) {
    return this.uiRecovery.get(device, id, hintId);
  }

  @Post('tasks/:id/form-fill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the AI which values the extra controls of the post form need (language, community…); answers within ~8 s or poll' })
  formFillRequest(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FormFillRequestDto) {
    return this.formFill.request(device, id, dto);
  }

  @Get('tasks/:id/form-fill/:hintId')
  @ApiOperation({ summary: 'Poll an AI form fill: actions the backend checked against the controls the extension sent' })
  formFillStatus(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Param('hintId', ParseUUIDPipe) hintId: string) {
    return this.formFill.get(device, id, hintId);
  }

  @Post('tasks/:id/auth')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  authStep(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionAuthStepDto) {
    return this.sessions.authStep(device, id, dto);
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@CurrentDevice() device: AuthenticatedDevice) {
    return this.agent.heartbeat(device);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(@CurrentDevice() device: AuthenticatedDevice, @Body() dto: ClaimExtensionTaskDto) {
    return { task: await this.agent.claim(device, dto.excludeOrigins, dto.supportedEngines, dto.authProtocol) };
  }

  @Get('tasks/:id/media/:assetId')
  media(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Param('assetId', ParseUUIDPipe) assetId: string) {
    return this.agent.taskMedia(device, id, assetId);
  }

  @Post('tasks/:id/result')
  @HttpCode(HttpStatus.OK)
  report(@CurrentDevice() device: AuthenticatedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtensionTaskResultDto) {
    return this.agent.report(device, id, dto);
  }
}
