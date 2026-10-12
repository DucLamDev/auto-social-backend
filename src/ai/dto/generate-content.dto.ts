import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { AI_PROVIDER_IDS, AiProvider } from '../ai-provider';

export class GenerateContentDto {
  @ApiProperty({ example: ['linkedin', 'wordpress'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  platforms!: string[];

  @ApiPropertyOptional({ enum: AI_PROVIDER_IDS, description: 'AI provider for this generation run. Uses the backend default when omitted.' })
  @IsOptional()
  @IsIn(AI_PROVIDER_IDS)
  aiProvider?: AiProvider;
}
