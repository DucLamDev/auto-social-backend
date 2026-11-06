import { HttpStatus } from '@nestjs/common';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { describeAutomationFailure } from './automation-failure';

describe('describeAutomationFailure', () => {
  it('keeps the cause of an application error and names a bug without leaking its text', () => {
    const now = new Date('2026-11-06T04:39:56Z');
    expect(describeAutomationFailure(new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, 'VPSTTT AI rate limit was reached. Try again later', HttpStatus.TOO_MANY_REQUESTS), 'camp-1', 'vpsttt', now))
      .toEqual({ code: 'PLATFORM_RATE_LIMITED', message: 'VPSTTT AI rate limit was reached. Try again later', provider: 'vpsttt', at: '2026-11-06T04:39:56.000Z' });
    const bug = describeAutomationFailure(new TypeError('secret internals: password=x'), 'camp-1', undefined, now);
    expect(bug).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Lỗi máy chủ khi tạo bài (TypeError). Xem log API của chiến dịch camp-1.' });
    expect(JSON.stringify(bug)).not.toContain('secret internals');
  });
});
