import { ApiProperty } from '@nestjs/swagger';
import { Equals } from 'class-validator';

export class ReconcileNotFoundDto {
  @ApiProperty({
    example: true,
    description: 'Explicit confirmation that the operator checked topics and moderation queues',
  })
  @Equals(true)
  confirmedNotFound!: true;
}
