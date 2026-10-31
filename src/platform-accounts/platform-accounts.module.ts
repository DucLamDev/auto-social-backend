import { Module } from '@nestjs/common';
import { PlatformAccountsController } from './platform-accounts.controller';
import { PlatformAccountsService } from './platform-accounts.service';
import { ApiAccountImportService } from './api-account-import.service';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [ConnectorsModule],
  controllers: [PlatformAccountsController],
  providers: [PlatformAccountsService, ApiAccountImportService],
  exports: [PlatformAccountsService],
})
export class PlatformAccountsModule {}
