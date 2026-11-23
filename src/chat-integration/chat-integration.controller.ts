import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ApiOkEnvelope } from '../common/swagger/api-contract.dto';
import { RedisService } from '../queue/redis.service';
import { ChatConfigService } from './chat-config.service';
import { ChatDispatcherService } from './chat-dispatcher.service';
import { ChatEventsService } from './chat-events.service';
import { CHAT_EVENTS_ROUTE } from './chat-integration.constants';
import { ChatEventAckContractDto, ChatIntegrationContractDto, ChatTestResultContractDto, UpdateChatIntegrationDto } from './chat-integration.dto';
import { ChatEventRequest, ChatWebhookGuard } from './chat-webhook.guard';

@ApiTags('settings')
@ApiBearerAuth()
@Roles(RoleName.ADMIN)
@Controller('settings/chat-integration')
export class ChatIntegrationSettingsController {
  constructor(
    private readonly chatConfig: ChatConfigService,
    private readonly dispatcher: ChatDispatcherService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @ApiOkEnvelope(ChatIntegrationContractDto)
  get() { return this.chatConfig.describe(); }

  @Put()
  @ApiOkEnvelope(ChatIntegrationContractDto)
  async update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateChatIntegrationDto) {
    const result = await this.chatConfig.update(dto);
    await this.audit.recordBestEffort({
      actorId: user.id, action: 'CHAT_INTEGRATION_UPDATED', entityType: 'system_settings', entityId: 'integration.chat',
      // Which fields changed, never their values.
      after: {
        enabled: result.enabled,
        changed: (['baseUrl', 'channelId', 'botToken', 'webhookSecret', 'previousWebhookSecret', 'clearPreviousWebhookSecret', 'enabled'] as const).filter((key) => dto[key] !== undefined),
      },
    });
    return result;
  }

  @Post('test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send one test message to the "Auto Social" channel' })
  @ApiOkEnvelope(ChatTestResultContractDto)
  async test(@CurrentUser() user: AuthenticatedUser) {
    // A button, not a load generator: at most 10 test messages per minute.
    const { allowed } = await this.redis.consumeRateLimit(`chat:test:${user.id}`, 10, 60);
    if (!allowed) return { ok: false, error: 'Gửi tin thử quá nhanh, đợi một phút rồi thử lại.' };
    return this.dispatcher.sendTest(user.displayName || user.email);
  }
}

@ApiTags('integrations')
@Controller(CHAT_EVENTS_ROUTE)
export class ChatEventsController {
  constructor(private readonly events: ChatEventsService, private readonly redis: RedisService) {}

  @Public()
  @Post()
  @HttpCode(200)
  @UseGuards(ChatWebhookGuard)
  @ApiOperation({ summary: 'Approval events from the VPSTTT chat (signed webhook, see CHAT_INTEGRATION.md)' })
  @ApiHeader({ name: 'X-WebTui-Timestamp', required: true })
  @ApiHeader({ name: 'X-WebTui-Signature', required: true })
  @ApiHeader({ name: 'X-WebTui-Signature-Previous', required: false })
  @ApiHeader({ name: 'X-WebTui-Event-ID', required: true })
  @ApiOkEnvelope(ChatEventAckContractDto)
  async receive(@Req() request: ChatEventRequest) {
    if (request.chatDuplicate) return { received: true, duplicate: true };
    const event = request.chatEvent!;
    try {
      const outcome = await this.events.handle(event);
      return { received: true, ...(outcome === 'ignored' ? { ignored: true } : {}) };
    } catch (error) {
      // Not handled: forget the event id so chat's retry is processed.
      await this.redis.deleteKey(`chat:webhook:event:${String(event.event_id)}`).catch(() => undefined);
      throw error;
    }
  }
}
