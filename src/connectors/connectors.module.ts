import { Module } from '@nestjs/common';
import { BloggerConnector } from './blogger/blogger.connector';
import { BlueskyConnector } from './bluesky/bluesky.connector';
import { ConnectorAccountsService } from './connector-accounts.service';
import { ConnectorsBootstrapService } from './connectors-bootstrap.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorRegistryService } from './core/connector-registry.service';
import { DevToConnector } from './devto/devto.connector';
import { DiscordConnector } from './discord/discord.connector';
import { InstagramConnector } from './instagram/instagram.connector';
import { LinkedInConnector } from './linkedin/linkedin.connector';
import { MastodonConnector } from './mastodon/mastodon.connector';
import { ThreadsConnector } from './threads/threads.connector';
import { WordPressConnector } from './wordpress/wordpress.connector';
import { XConnector } from './x/x.connector';

const implementations = [
  InstagramConnector,
  ThreadsConnector,
  XConnector,
  LinkedInConnector,
  WordPressConnector,
  BloggerConnector,
  DevToConnector,
  DiscordConnector,
  BlueskyConnector,
  MastodonConnector,
];

@Module({
  controllers: [ConnectorsController],
  providers: [ConnectorRegistryService, ConnectorAccountsService, ConnectorsBootstrapService, ...implementations],
  exports: [ConnectorRegistryService, ConnectorAccountsService],
})
export class ConnectorsModule {}
