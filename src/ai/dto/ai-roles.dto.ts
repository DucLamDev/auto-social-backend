import { ApiProperty } from '@nestjs/swagger';
import { AI_PROVIDER_IDS } from '../ai-provider';

export class AiRoleContractDto {
  @ApiProperty({ enum: AI_PROVIDER_IDS, example: 'vpsttt' }) provider!: string;
  @ApiProperty({ example: 'claude:opus', description: 'Model used for this role (the provider default when not set).' }) model!: string;
  @ApiProperty({ example: 'Claude Opus' }) label!: string;
  @ApiProperty({ description: 'False when the provider has no key: the reviewer then falls back to the writer, approvals fail.' }) configured!: boolean;
}

export class AiRolesContractDto {
  @ApiProperty({ type: AiRoleContractDto, description: 'Scores every draft and checks seeding and risk for the company (AI_REVIEWER).' })
  reviewer!: AiRoleContractDto;

  @ApiProperty({ type: AiRoleContractDto, description: 'Final gate on the finished draft (AI_APPROVER).' })
  approver!: AiRoleContractDto;

  @ApiProperty({ type: AiRoleContractDto, description: 'Writes "Viết lại bằng AI" / "Sửa theo khuyến nghị" (AI_REVISER); the campaign writer when its provider has no key.' })
  reviser!: AiRoleContractDto;

  @ApiProperty({ description: 'AI_APPROVAL_ENABLED: whether drafts go through the final approver.' })
  approvalEnabled!: boolean;
}
