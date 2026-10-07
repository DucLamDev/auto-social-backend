import { ErrorCode } from '../../common/exceptions/application.exception';
import {
  ConnectorOutboundHttpClient,
  ConnectorOutboundHttpResponse,
} from './connector-outbound-http.client';
import { ConnectorError, mapHttpError } from './connector-error';

export abstract class HttpConnectorBase {
  private readonly guardedHttp = new ConnectorOutboundHttpClient();

  protected async request<T>(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
  ): Promise<{ data: T; headers: { get(name: string): string | null } }> {
    return this.execute<T>(async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    });
  }

  protected async requestDynamic<T>(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
  ): Promise<{ data: T; headers: { get(name: string): string | null } }> {
    return this.execute<T>(() => this.guardedHttp.request(url, init, timeoutMs));
  }

  private async execute<T>(
    operation: () => Promise<ConnectorOutboundHttpResponse>,
  ): Promise<{ data: T; headers: { get(name: string): string | null } }> {
    try {
      const response = await operation();
      let data: unknown = undefined;
      if (response.text) {
        try {
          data = JSON.parse(response.text);
        } catch {
          data = { message: response.text.slice(0, 500) };
        }
      }
      if (!response.ok) throw mapHttpError(response.status, data, response.headers.get('retry-after'));
      return { data: data as T, headers: response.headers };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new ConnectorError(ErrorCode.PUBLISH_TIMEOUT, 'Platform request timed out', true);
      }
      throw new ConnectorError(ErrorCode.PLATFORM_API_ERROR, 'Platform network request failed', true);
    }
  }

  protected requiredString(source: Record<string, unknown>, key: string): string {
    const value = source[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        `Connector credential/configuration '${key}' is required`,
        false,
      );
    }
    return value;
  }

  protected normalizeBaseUrl(value: string): string {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Connector base URL must be an absolute HTTPS URL', false); }
    if (url.protocol !== 'https:') throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Connector base URL must use HTTPS', false);
    if (url.username || url.password) throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Connector base URL must not contain URL credentials', false);
    return url.toString().replace(/\/$/, '');
  }
}
