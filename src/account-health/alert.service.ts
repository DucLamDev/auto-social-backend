import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sends short operator notices to one chat webhook (Slack, Google Chat,
 * Discord or any endpoint accepting `{ text }`). Messages carry account names,
 * statuses and error codes only, never tokens or post bodies. Delivery is best
 * effort: a broken webhook must not stop token refresh or publishing.
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.webhookUrl());
  }

  async send(lines: string[]): Promise<boolean> {
    const url = this.webhookUrl();
    if (!url || lines.length === 0) return false;
    const text = ['[Social Publisher]', ...lines].join('\n').slice(0, 1900);
    const body = new URL(url).hostname.endsWith('discord.com') ? { content: text } : { text };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) this.logger.warn(`Alert webhook responded with HTTP ${response.status}`);
      return response.ok;
    } catch {
      this.logger.warn('Alert webhook request failed');
      return false;
    }
  }

  private webhookUrl(): string | undefined {
    return this.config.get<string>('ALERT_WEBHOOK_URL')?.trim() || undefined;
  }
}
