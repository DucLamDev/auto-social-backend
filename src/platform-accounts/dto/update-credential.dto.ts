import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class UpdateCredentialDto {
  @ApiProperty({ type: 'object', additionalProperties: true, writeOnly: true })
  @IsObject()
  credential!: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Non-secret connector settings to merge into the existing account settings.',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
