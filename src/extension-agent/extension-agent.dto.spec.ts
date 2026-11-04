import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ExtensionTaskResultDto } from './extension-agent.dto';

// The same pipe main.ts installs: unknown fields are rejected, not stripped.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: ExtensionTaskResultDto });

describe('ExtensionTaskResultDto', () => {
  it('accepts the sign-in details the extension adds when it stops on a login problem', async () => {
    await expect(validate({ outcome: 'NEEDS_ACTION', reason: 'ACCOUNT_MISMATCH', message: 'Chrome đang đăng nhập tài khoản khác', detectedUsername: 'other_user', googleBlocked: false }))
      .resolves.toMatchObject({ detectedUsername: 'other_user', googleBlocked: false });
    await expect(validate({ outcome: 'NEEDS_ACTION', reason: 'AUTH_REQUIRED', googleBlocked: true })).resolves.toMatchObject({ googleBlocked: true });
  });

  it('accepts a failure because the editor did not keep the text', async () => {
    await expect(validate({ outcome: 'FAILED', reason: 'CONTENT_MISMATCH' })).resolves.toMatchObject({ reason: 'CONTENT_MISMATCH' });
  });

  it('still rejects malformed details and unknown fields', async () => {
    await expect(validate({ outcome: 'NEEDS_ACTION', detectedUsername: 'x'.repeat(201) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ outcome: 'NEEDS_ACTION', googleBlocked: 'yes' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ outcome: 'NEEDS_ACTION', password: 'leak' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ outcome: 'FAILED', reason: 'SOMETHING_ELSE' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
