import { extensionFlowAudit } from './extension-flow-audit';

describe('posting flow status shown after a login check', () => {
  it('says Warrior Forum is manual only because its terms forbid automated access', () => {
    expect(extensionFlowAudit('warrior-forum', {})).toMatchObject({ status: 'MANUAL_ONLY', implemented: false, url: 'https://www.warriorforum.com/tos.html' });
    expect(extensionFlowAudit('warrior-forum', {}).message).toMatch(/cấm bot/);
  });

  it('keeps the other gaps as they were', () => {
    expect(extensionFlowAudit('disqus', {})).toMatchObject({ status: 'UNAVAILABLE', implemented: false });
    expect(extensionFlowAudit('daily-dev', {})).toMatchObject({ status: 'FLOW_REQUIRED', implemented: false });
    expect(extensionFlowAudit('voz-forums', {})).toMatchObject({ status: 'DESTINATION_REQUIRED', implemented: true, engine: 'xenforo' });
  });
});
