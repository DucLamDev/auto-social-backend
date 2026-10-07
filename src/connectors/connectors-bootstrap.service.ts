import { Injectable, OnModuleInit } from '@nestjs/common';
import { BloggerConnector } from './blogger/blogger.connector';
import { BlueskyConnector } from './bluesky/bluesky.connector';
import { ConnectorRegistryService } from './core/connector-registry.service';
import { DevToConnector } from './devto/devto.connector';
import { DiscordConnector } from './discord/discord.connector';
import { InstagramConnector } from './instagram/instagram.connector';
import { LinkedInConnector } from './linkedin/linkedin.connector';
import { ManualConnector } from './manual/manual.connector';
import { MastodonConnector } from './mastodon/mastodon.connector';
import { ThreadsConnector } from './threads/threads.connector';
import { WordPressConnector } from './wordpress/wordpress.connector';
import { XConnector } from './x/x.connector';

@Injectable()
export class ConnectorsBootstrapService implements OnModuleInit {
  constructor(
    private readonly registry: ConnectorRegistryService,
    private readonly instagram: InstagramConnector,
    private readonly threads: ThreadsConnector,
    private readonly x: XConnector,
    private readonly linkedin: LinkedInConnector,
    private readonly wordpress: WordPressConnector,
    private readonly blogger: BloggerConnector,
    private readonly devto: DevToConnector,
    private readonly discord: DiscordConnector,
    private readonly bluesky: BlueskyConnector,
    private readonly mastodon: MastodonConnector,
  ) {}

  onModuleInit(): void {
    [
      this.instagram,
      this.threads,
      this.x,
      this.linkedin,
      this.wordpress,
      this.blogger,
      this.devto,
      this.discord,
      this.bluesky,
      this.mastodon,
      new ManualConnector('reddit'),
      new ManualConnector('tiktok'),
    ].forEach((connector) => this.registry.register(connector));
  }
}
