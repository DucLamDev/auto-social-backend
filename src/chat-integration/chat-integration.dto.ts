import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateChatIntegrationDto {
  @ApiProperty({ description: 'Revision returned by GET; a stale value is refused with 409.' })
  @IsString() @MaxLength(50) revision!: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiPropertyOptional({ description: 'Chat server origin, https only (for example https://chat.example.com).' })
  @IsOptional() @IsString() @MaxLength(2048) baseUrl?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Id of the "Auto Social" channel the bot is installed in.' })
  @IsOptional() @IsUUID() channelId?: string;

  @ApiPropertyOptional({ writeOnly: true, description: 'New bot key (wtb_…). Omit to keep the saved one.' })
  @IsOptional() @IsString() @MinLength(10) @MaxLength(512) @Matches(/^wtb_\S+$/, { message: 'Khoá bot phải bắt đầu bằng wtb_ và không có khoảng trắng.' })
  botToken?: string;

  @ApiPropertyOptional({ writeOnly: true, description: 'New outgoing-webhook secret. The previous one is kept as the old key.' })
  @IsOptional() @IsString() @MinLength(16) @MaxLength(512) @Matches(/^\S+$/) webhookSecret?: string;

  @ApiPropertyOptional({ writeOnly: true, description: 'Old webhook secret, accepted for 24 hours from now while chat rotates keys.' })
  @IsOptional() @IsString() @MinLength(16) @MaxLength(512) @Matches(/^\S+$/) previousWebhookSecret?: string;

  @ApiPropertyOptional({ description: 'Forget the old webhook secret.' })
  @IsOptional() @IsBoolean() clearPreviousWebhookSecret?: boolean;
}

export class ChatLastDeliveryContractDto {
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty() ok!: boolean;
  @ApiProperty() kind!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) error!: string | null;
}

export class ChatIntegrationContractDto {
  @ApiProperty() revision!: string;
  @ApiProperty() configured!: boolean;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) baseUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) channelId!: string | null;
  @ApiProperty() botTokenConfigured!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Masked bot key, for example wtb_…a1b2.' }) botTokenHint!: string | null;
  @ApiProperty() webhookSecretConfigured!: boolean;
  @ApiProperty({ description: 'An old webhook secret is still accepted (24 h after the rotation).' }) previousWebhookSecretConfigured!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'When the old webhook secret stops being accepted.' }) previousWebhookSecretExpiresAt!: string | null;
  @ApiProperty({ description: 'Path chat must call, under the API origin.' }) webhookPath!: string;
  @ApiProperty({ description: 'Events still waiting to be sent.' }) pendingCount!: number;
  @ApiProperty({ description: 'Events that gave up after all retries.' }) failedCount!: number;
  @ApiProperty({ type: ChatLastDeliveryContractDto, nullable: true }) lastDelivery!: ChatLastDeliveryContractDto | null;
}

export class ChatTestResultContractDto {
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) error!: string | null;
}

export class ChatEventAckContractDto {
  @ApiProperty() received!: boolean;
  @ApiPropertyOptional() duplicate?: boolean;
  @ApiPropertyOptional() ignored?: boolean;
}
