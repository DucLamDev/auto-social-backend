import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from './credential-encryption.service';

describe('CredentialEncryptionService', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const service = new CredentialEncryptionService(
    new ConfigService({ CREDENTIAL_ENCRYPTION_KEY: key, CREDENTIAL_ENCRYPTION_KEY_VERSION: 'test-v1' }),
  );

  it('round-trips structured credentials without plaintext in the ciphertext', () => {
    const input = { accessToken: 'secret-token-value', nested: { clientSecret: 'also-secret' } };
    const encrypted = service.encrypt(input);
    expect(encrypted).not.toContain('secret-token-value');
    expect(service.decrypt(encrypted)).toEqual(input);
  });

  it('uses a fresh IV for every encryption', () => {
    expect(service.encrypt({ token: 'same' })).not.toEqual(service.encrypt({ token: 'same' }));
  });

  it('rejects a tampered authentication tag', () => {
    const encrypted = service.encrypt({ token: 'secret' });
    const parts = encrypted.split('.');
    parts[2] = Buffer.alloc(16, 1).toString('base64url');
    expect(() => service.decrypt(parts.join('.'))).toThrow();
  });
});
