import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdatePlatformAccountSettingsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Non-secret connector settings to merge. Credentials and encrypted browser session state are left unchanged.',
  })
  @IsObject()
  settings!: Record<string, unknown>;
}
