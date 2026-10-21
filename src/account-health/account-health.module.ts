import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AccountHealthController } from './account-health.controller';
import { AccountHealthService } from './account-health.service';
import { AlertService } from './alert.service';

@Module({
  imports: [ConnectorsModule],
  controllers: [AccountHealthController],
  providers: [AccountHealthService, AlertService],
  exports: [AccountHealthService, AlertService],
})
export class AccountHealthModule {}
