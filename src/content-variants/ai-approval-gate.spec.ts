import { approvalHash, type AiApproval } from '../ai/content-approval';
import { aiApprovalCurrent, aiApprovalProblem, storedApprovalProblem, withAiApprovalCurrent } from './ai-approval-gate';

const post = { title: 'VPS giá rẻ', body: 'Bài viết về VPS.', hashtags: ['vps'] };
const verdict = (extra: Partial<AiApproval> = {}): AiApproval => ({
  status: 'approved', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: approvalHash(post),
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null, ...extra,
});

describe('final AI approver gate', () => {
  it('lets out only a post the approver said yes to, for exactly its current text', () => {
    expect(aiApprovalProblem({ ...post, aiApproval: verdict() }, true)).toBeNull();
    // Same text after the normalization the hash applies (spacing, "#", case of tags).
    expect(aiApprovalProblem({ ...post, hashtags: ['#VPS'], body: ' Bài viết về VPS. ', aiApproval: verdict() }, true)).toBeNull();
  });

  it('explains in Vietnamese why each other state is blocked', () => {
    expect(aiApprovalProblem({ ...post, aiApproval: null }, true)).toBe('Chưa được AI duyệt cuối; bấm Cho AI duyệt.');
    expect(aiApprovalProblem({ ...post, aiApproval: verdict({ status: 'running', finishedAt: null }) }, true)).toBe('AI duyệt cuối đang đọc bài…');
    expect(aiApprovalProblem({ ...post, aiApproval: verdict({ status: 'rejected', reasons: ['Giả làm khách hàng', 'Hứa hẹn quá mức'] }) }, true))
      .toBe('AI duyệt cuối (Claude Opus) từ chối: Giả làm khách hàng; Hứa hẹn quá mức');
    expect(aiApprovalProblem({ ...post, aiApproval: verdict({ status: 'failed', error: 'Key không được dùng model này.' }) }, true))
      .toBe('AI duyệt cuối chưa chạy được: Key không được dùng model này.');
    expect(aiApprovalProblem({ ...post, body: 'Đã sửa.', aiApproval: verdict() }, true)).toBe('Bài đã sửa sau khi AI duyệt; đang chờ duyệt lại.');
    // A run lost to a restart can be started again.
    expect(aiApprovalProblem({ ...post, aiApproval: verdict({ status: 'running', startedAt: new Date(Date.now() - 11 * 60_000).toISOString() }) }, true))
      .toContain('bị gián đoạn');
  });

  it('blocks nothing when the approver is off', () => {
    expect(aiApprovalProblem({ ...post, aiApproval: verdict({ status: 'rejected' }) }, false)).toBeNull();
    expect(aiApprovalProblem({ ...post, aiApproval: null }, false)).toBeNull();
  });

  it('lets a variant approved before the approver existed through the stored-verdict check only', () => {
    expect(storedApprovalProblem({ ...post, aiApproval: null }, true)).toBeNull();
    expect(storedApprovalProblem({ ...post, aiApproval: verdict({ status: 'rejected', reasons: ['Seeding vụng'] }) }, true)).toContain('từ chối: Seeding vụng');
    expect(storedApprovalProblem({ ...post, body: 'Đã sửa.', aiApproval: verdict() }, true)).toContain('Bài đã sửa');
  });

  it('marks whether the stored verdict is for the current text', () => {
    expect(aiApprovalCurrent(verdict({ status: 'rejected' }), post)).toBe(true);
    expect(aiApprovalCurrent(verdict(), { ...post, title: 'Khác' })).toBe(false);
    expect(aiApprovalCurrent(null, post)).toBe(false);
    const approval = verdict();
    expect(withAiApprovalCurrent({ id: 'v1', ...post, aiApproval: approval })).toEqual({ id: 'v1', ...post, aiApproval: approval, aiApprovalCurrent: true });
  });
});
