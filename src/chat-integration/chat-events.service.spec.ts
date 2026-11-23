import { BadRequestException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CampaignAutomationService } from '../campaigns/campaign-automation.service';
import { PrismaService } from '../database/prisma.service';
import { ChatApiClient } from './chat-api.client';
import { ChatConfigService } from './chat-config.service';
import { ChatEventsService } from './chat-events.service';
import { ChatOutboxService } from './chat-outbox.service';
import { ApprovalContentChangedError } from './chat-snapshot';

const OWNER = { id: 'owner-1', enabled: true, roles: [{ role: { name: RoleName.EDITOR } }] };

function setup(user: unknown = OWNER, linkPatch: Record<string, unknown> = {}) {
  const link = { id: 'link-1', campaignId: 'campaign-1', variantId: 'variant-1', approvalId: 'approval-1', status: 'PENDING', contentHash: 'hash-1', externalKey: 'variant:variant-1:c1', ...linkPatch };
  const prisma = {
    chatApprovalLink: {
      findUnique: jest.fn(({ where }: { where: Record<string, unknown> }) => Promise.resolve(where.approvalId && !link.approvalId ? null : link)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    campaign: { findUnique: jest.fn().mockResolvedValue({ id: 'campaign-1', ownerId: 'owner-1', scheduledAt: new Date(Date.now() + 3_600_000) }) },
    user: { findFirst: jest.fn().mockResolvedValue(user) },
    campaignTarget: { count: jest.fn().mockResolvedValue(0) },
    contentVariant: { count: jest.fn().mockResolvedValue(0) },
  };
  const automation = { approveVariant: jest.fn().mockResolvedValue({}), rejectVariant: jest.fn().mockResolvedValue({}) };
  const audit = { recordBestEffort: jest.fn() };
  const outbox = { record: jest.fn().mockResolvedValue(true), reviewReady: jest.fn() };
  const chatConfig = { active: jest.fn().mockResolvedValue({ baseUrl: 'https://chat.example.com', botToken: 'wtb_x', channelId: 'c' }) };
  const api = { getApproval: jest.fn() };
  const service = new ChatEventsService(prisma as unknown as PrismaService, automation as unknown as CampaignAutomationService, audit as unknown as AuditService,
    outbox as unknown as ChatOutboxService, chatConfig as unknown as ChatConfigService, api as unknown as ChatApiClient);
  return { service, prisma, automation, audit, outbox, api };
}

const event = (status: string, decision: 'approve' | 'reject', email = 'Chu.Chien.Dich@vpsttt.com', note = '', patch: Record<string, unknown> = {}) => ({
  event_id: 'evt-1',
  event_type: 'approval.decided',
  payload: {
    approval_id: 'approval-1', status, action: 'auto_social.publish_variant', resource_id: 'variant-1', external_key: 'variant:variant-1:c1',
    decisions: [{ user_email: email, decision, note, decided_at: '2026-11-23T03:00:00Z' }], ...patch,
  },
});

describe('ChatEventsService', () => {
  it('approves and rejects through the web review functions, scheduled like the campaign, with chat as the source', async () => {
    const { service, automation, prisma } = setup();
    await expect(service.handle(event('approved', 'approve'))).resolves.toBe('applied');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: { equals: 'chu.chien.dich@vpsttt.com', mode: 'insensitive' } } }));
    expect(automation.approveVariant).toHaveBeenCalledWith('owner-1', 'campaign-1', 'variant-1',
      { publishMode: 'SCHEDULED', scheduledAt: expect.any(String) as unknown }, { source: 'chat', approvalId: 'approval-1', expectedHash: 'hash-1' });
    // The link is claimed before the decision so its own hook does not cancel it.
    expect(prisma.chatApprovalLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'APPROVED', approvalId: 'approval-1' } }));

    await expect(service.handle(event('rejected', 'reject', 'chu.chien.dich@vpsttt.com', 'Sai giá'))).resolves.toBe('applied');
    expect(automation.rejectVariant).toHaveBeenCalledWith('owner-1', 'campaign-1', 'variant-1', { source: 'chat', approvalId: 'approval-1', note: 'Sai giá', expectedHash: 'hash-1' });
  });

  it.each([
    ['someone who does not own the campaign', { ...OWNER, id: 'other-user' }, 'NOT_OWNER'],
    ['a VIEWER', { ...OWNER, roles: [{ role: { name: RoleName.VIEWER } }] }, 'ROLE_NOT_ALLOWED'],
    ['a disabled account', { ...OWNER, enabled: false }, 'USER_DISABLED'],
  ])('ignores a decision by %s, audits it and reports the failure to chat', async (_label, user, reason) => {
    const { service, automation, audit, outbox } = setup(user);
    await expect(service.handle(event('approved', 'approve'))).resolves.toBe('rejected_decider');
    expect(automation.approveVariant).not.toHaveBeenCalled();
    expect(audit.recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ action: 'CHAT_APPROVAL_IGNORED', after: expect.objectContaining({ source: 'chat', reason }) as unknown }));
    expect(outbox.record).toHaveBeenCalledWith('APPROVAL_RESULT', 'result:approval-1', { approvalId: 'approval-1', status: 'failed', error: 'Người duyệt không hợp lệ.' });
  });

  it('reports a refusal in Vietnamese, asks again when the post changed, and does not report a failure once the approval is stored', async () => {
    const { service, automation, outbox, prisma } = setup();
    automation.approveVariant.mockRejectedValueOnce(new BadRequestException('Bài X dài 600/500 ký tự, vượt giới hạn của nền tảng.'));
    await expect(service.handle(event('approved', 'approve'))).resolves.toBe('failed');
    expect(outbox.record).toHaveBeenCalledWith('APPROVAL_RESULT', 'result:approval-1', expect.objectContaining({ status: 'failed', error: 'Bài X dài 600/500 ký tự, vượt giới hạn của nền tảng.' }));
    expect(outbox.reviewReady).not.toHaveBeenCalled();

    automation.approveVariant.mockRejectedValueOnce(new ApprovalContentChangedError());
    await expect(service.handle(event('approved', 'approve'))).resolves.toBe('failed');
    expect(outbox.reviewReady).toHaveBeenCalledWith('campaign-1', ['variant-1']);

    outbox.record.mockClear();
    prisma.campaignTarget.count.mockResolvedValue(1);
    automation.approveVariant.mockRejectedValueOnce(new Error('publish step failed'));
    await expect(service.handle(event('approved', 'approve'))).resolves.toBe('applied');
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it("acts only on this bot's own approval: other action, other resource, or an id chat does not give this bot", async () => {
    const owned = setup();
    await expect(owned.service.handle(event('approved', 'approve', undefined, '', { action: 'other.bot_action' }))).resolves.toBe('ignored');
    await expect(owned.service.handle(event('approved', 'approve', undefined, '', { resource_id: 'variant-9' }))).resolves.toBe('ignored');
    expect(owned.automation.approveVariant).not.toHaveBeenCalled();

    // Link not yet holding the id: chat is asked with our bot key; 404 means another bot's request.
    const fresh = setup(OWNER, { approvalId: null });
    fresh.api.getApproval.mockResolvedValueOnce({ status: 404, ok: false, data: null });
    await expect(fresh.service.handle(event('approved', 'approve'))).resolves.toBe('ignored');
    expect(fresh.automation.approveVariant).not.toHaveBeenCalled();
    expect(fresh.audit.recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ reason: 'NOT_OUR_APPROVAL' }) as unknown }));

    fresh.api.getApproval.mockResolvedValueOnce({ status: 200, ok: true, data: { approval: { id: 'approval-1', external_key: 'variant:variant-1:c1' } } });
    await expect(fresh.service.handle(event('approved', 'approve'))).resolves.toBe('applied');
    expect(fresh.prisma.chatApprovalLink.updateMany).toHaveBeenCalledWith({ where: { id: 'link-1', approvalId: null }, data: { approvalId: 'approval-1' } });
  });
});
