import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BloggerConnector } from './blogger/blogger.connector';
import { BlueskyConnector } from './bluesky/bluesky.connector';
import { ConnectorAccountsService } from './connector-accounts.service';
import { ConnectorsBootstrapService } from './connectors-bootstrap.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorRegistryService } from './core/connector-registry.service';
import { DevToConnector } from './devto/devto.connector';
import { DiscourseConnector } from './discourse/discourse.connector';
import { DiscordConnector } from './discord/discord.connector';
import { InstagramConnector } from './instagram/instagram.connector';
import { LinkedInConnector } from './linkedin/linkedin.connector';
import { MastodonConnector } from './mastodon/mastodon.connector';
import { ThreadsConnector } from './threads/threads.connector';
import { WordPressConnector } from './wordpress/wordpress.connector';
import { XConnector } from './x/x.connector';
import { BrowserAssistedConnector } from './browser/browser-assisted.connector';
import { BrowserAutomationService } from './browser/browser-automation.service';
import { BrowserChallengeDetector } from './browser/browser-challenge.detector';
import { BrowserRecipeRegistry } from './browser/browser-recipe.registry';
import { BrowserSessionStateStore } from './browser/browser-session-state.store';
import { BrowserNetworkGuard } from './browser/browser-network-guard.service';
import { BrowserLoginCaptureService } from './browser/browser-login-capture.service';
import {
  BROWSER_MEDIA_HTTP_CLIENT,
  BrowserMediaPreparationService,
  createBrowserMediaHttpClient,
} from './browser/browser-media-preparation.service';
import { BrowserRecipesBootstrapService } from './browser/browser-recipes-bootstrap.service';
import { VozXenForoBrowserRecipe } from './browser/recipes/xenforo-browser.recipe';
import { BrowserSubmissionAuthorizationService } from './browser/browser-submission-authorization.service';

const implementations = [
  InstagramConnector,
  ThreadsConnector,
  XConnector,
  LinkedInConnector,
  WordPressConnector,
  BloggerConnector,
  DevToConnector,
  DiscourseConnector,
  DiscordConnector,
  BlueskyConnector,
  MastodonConnector,
  BrowserAssistedConnector,
  BrowserAutomationService,
  BrowserChallengeDetector,
  BrowserRecipeRegistry,
  BrowserSessionStateStore,
  BrowserNetworkGuard,
  BrowserLoginCaptureService,
  BrowserRecipesBootstrapService,
  VozXenForoBrowserRecipe,
  BrowserMediaPreparationService,
  BrowserSubmissionAuthorizationService,
  {
    provide: BROWSER_MEDIA_HTTP_CLIENT,
    useFactory: createBrowserMediaHttpClient,
  },
];

@Module({
  imports: [StorageModule],
  controllers: [ConnectorsController],
  providers: [
    ConnectorRegistryService,
    ConnectorAccountsService,
    ConnectorsBootstrapService,
    ...implementations,
  ],
  exports: [
    ConnectorRegistryService,
    ConnectorAccountsService,
    BrowserLoginCaptureService,
    BrowserRecipeRegistry,
  ],
})
export class ConnectorsModule {}
