import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Optional when sent in the httpOnly refresh_token cookie' })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
