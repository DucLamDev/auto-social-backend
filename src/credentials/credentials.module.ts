import { Global, Module } from '@nestjs/common';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CredentialsService } from './credentials.service';
import { MetaTokenService } from './meta-token.service';

@Global()
@Module({
  providers: [CredentialEncryptionService, CredentialsService, MetaTokenService],
  exports: [CredentialEncryptionService, CredentialsService, MetaTokenService],
})
export class CredentialsModule {}
