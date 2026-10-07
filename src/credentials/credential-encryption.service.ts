import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

@Injectable()
export class CredentialEncryptionService {
  private readonly key: Buffer;
  readonly keyVersion: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('CREDENTIAL_ENCRYPTION_KEY');
    this.key = configured
      ? Buffer.from(configured, 'base64')
      : createHash('sha256').update('development-only-credential-key').digest();
    if (this.key.length !== 32) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
    this.keyVersion = config.get<string>('CREDENTIAL_ENCRYPTION_KEY_VERSION', 'v1');
  }

  encrypt(value: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.keyVersion, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [this.keyVersion, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(payload: string): Record<string, unknown> {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = payload.split('.');
    if (!version || !encodedIv || !encodedTag || !encodedCiphertext || extra) {
      throw new Error('Encrypted credential payload has an invalid format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAAD(Buffer.from(version, 'utf8'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Decrypted credential payload is invalid');
    }
    return parsed as Record<string, unknown>;
  }
}
