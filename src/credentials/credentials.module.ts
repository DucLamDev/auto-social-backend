import { Global, Module } from '@nestjs/common';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CredentialsService } from './credentials.service';

@Global()
@Module({
  providers: [CredentialEncryptionService, CredentialsService],
  exports: [CredentialEncryptionService, CredentialsService],
})
export class CredentialsModule {}
