import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdateCredentialDto {
  @ApiProperty({ type: 'object', additionalProperties: true, writeOnly: true })
  @IsObject()
  credential!: Record<string, unknown>;
}
