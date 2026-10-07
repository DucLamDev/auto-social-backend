import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(input: {
    actorId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    requestId?: string;
    ipAddress?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
        before: input.before as Prisma.InputJsonObject | undefined,
        after: input.after as Prisma.InputJsonObject | undefined,
      },
    });
  }

  async recordBestEffort(input: Parameters<AuditService['record']>[0]): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.warn(`Audit write failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
