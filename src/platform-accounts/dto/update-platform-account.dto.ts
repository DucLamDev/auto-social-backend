import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdatePlatformAccountDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}
