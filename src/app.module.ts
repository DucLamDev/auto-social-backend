import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ApplicationConfigModule } from './config/config.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { ContentSourcesModule } from './content-sources/content-sources.module';
import { ContentVariantsModule } from './content-variants/content-variants.module';
import { ContentsModule } from './contents/contents.module';
import { CredentialsModule } from './credentials/credentials.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LogsModule } from './logs/logs.module';
import { MediaModule } from './media/media.module';
import { OAuthModule } from './oauth/oauth.module';
import { PlatformAccountsModule } from './platform-accounts/platform-accounts.module';
import { PlatformsModule } from './platforms/platforms.module';
import { PromptsModule } from './prompts/prompts.module';
import { PublishingModule } from './publishing/publishing.module';
import { QueueModule } from './queue/queue.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SettingsModule } from './settings/settings.module';
import { SourceArticlesModule } from './source-articles/source-articles.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    AuditModule,
    CredentialsModule,
    QueueModule,
    AuthModule,
    UsersModule,
    PlatformsModule,
    ConnectorsModule,
    PlatformAccountsModule,
    ContentSourcesModule,
    ContentsModule,
    SourceArticlesModule,
    ContentVariantsModule,
    AiModule,
    PromptsModule,
    CampaignsModule,
    PublishingModule,
    SchedulerModule,
    MediaModule,
    LogsModule,
    SettingsModule,
    OAuthModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
