import { Module } from '@nestjs/common';
import { OAuthController } from './oauth.controller';
import { OAuthStateService } from './oauth-state.service';
import { OAuthService } from './oauth.service';

@Module({ controllers: [OAuthController], providers: [OAuthStateService, OAuthService], exports: [OAuthStateService] })
export class OAuthModule {}
