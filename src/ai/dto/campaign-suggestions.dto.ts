import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AI_PROVIDER_IDS, AiProvider } from '../ai-provider';
import { MAX_SUGGESTION_HINT, MAX_SUGGESTION_PLATFORMS } from '../campaign-suggestions';

export class CampaignSuggestionsDto {
  @ApiProperty({ type: [String], description: 'Slugs of the platforms chosen in the campaign form.', example: ['bluesky', 'nginx-community'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SUGGESTION_PLATFORMS)
  @IsString({ each: true })
  @Matches(/^[a-z0-9-]{1,64}$/, { each: true })
  platformSlugs!: string[];

  @ApiPropertyOptional({ description: 'What the operator wants ideas about (optional).', example: 'proxy dân cư cho người làm affiliate' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUGGESTION_HINT)
  hint?: string;

  @ApiPropertyOptional({ enum: AI_PROVIDER_IDS })
  @IsOptional()
  @IsIn(AI_PROVIDER_IDS)
  aiProvider?: AiProvider;
}
