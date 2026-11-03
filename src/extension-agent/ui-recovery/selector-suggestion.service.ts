import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { ApprovedSelector } from './selector-merge';

export type SuggestionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

const SUGGESTION_SELECT = {
  id: true, engine: true, origin: true, field: true, selector: true, status: true, sampleUrl: true, elementSummary: true,
  confidence: true, seenCount: true, reviewedAt: true, createdAt: true, updatedAt: true,
} as const;

/** Operator review of AI-proposed selectors (REST and MCP). */
@Injectable()
export class ExtensionSelectorSuggestionService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(ownerId: string, filter: { status?: SuggestionStatus; engine?: string; limit?: number } = {}) {
    return this.prisma.extensionSelectorSuggestion.findMany({
      where: { ownerId, ...(filter.status ? { status: filter.status } : {}), ...(filter.engine ? { engine: filter.engine } : {}) },
      select: SUGGESTION_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(filter.limit ?? 100, 1), 200),
    });
  }

  approve(ownerId: string, id: string, reviewerId: string) {
    return this.review(ownerId, id, reviewerId, 'APPROVED');
  }

  reject(ownerId: string, id: string, reviewerId: string) {
    return this.review(ownerId, id, reviewerId, 'REJECTED');
  }

  /** Approved selectors for one destination, newest review first. */
  async approvedFor(ownerId: string, engine: string, origin: string): Promise<ApprovedSelector[]> {
    return this.prisma.extensionSelectorSuggestion.findMany({
      where: { ownerId, engine, origin, status: 'APPROVED' },
      select: { field: true, selector: true },
      orderBy: { reviewedAt: 'desc' },
      take: 20,
    });
  }

  private async review(ownerId: string, id: string, reviewerId: string, status: Exclude<SuggestionStatus, 'PENDING'>) {
    const result = await this.prisma.extensionSelectorSuggestion.updateMany({
      where: { id, ownerId },
      data: { status, reviewedById: reviewerId, reviewedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('Selector suggestion not found');
    await this.audit.recordBestEffort({ actorId: reviewerId, action: `SELECTOR_SUGGESTION_${status}`, entityType: 'extension-selector-suggestions', entityId: id });
    return this.prisma.extensionSelectorSuggestion.findFirstOrThrow({ where: { id, ownerId }, select: SUGGESTION_SELECT });
  }
}
