import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { ApproveAiCampaignDto } from './approve-ai-campaign.dto';

export class ReviewExistingContentDto extends ApproveAiCampaignDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4', { each: true })
  platformAccountIds!: string[];

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsUUID('4', { each: true })
  variantIds!: string[];
}
