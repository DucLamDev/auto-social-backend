import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from './connector-error';
import { PublishResult } from './connector.types';

/** Meta values: FINISHED, IN_PROGRESS, ERROR, EXPIRED, PUBLISHED. */
export type ContainerStatus = string;

export interface ContainerPollOptions {
  intervalMs: number;
  maxPolls: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Instagram and Threads create a media container first and process uploads
 * asynchronously; publishing before the container is FINISHED fails. Nothing
 * is public yet while waiting, so a timeout is safe to retry from scratch.
 */
export async function waitForMetaContainer(
  readStatus: () => Promise<ContainerStatus | undefined>,
  options: ContainerPollOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  for (let poll = 0; poll < options.maxPolls; poll += 1) {
    const status = await readStatus();
    if (status === 'FINISHED' || status === undefined) return;
    if (status === 'ERROR') {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'The platform could not process the media container', false);
    }
    if (status === 'EXPIRED' || status === 'PUBLISHED') {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, `Media container is ${status.toLowerCase()} and cannot be published`, false);
    }
    await sleep(options.intervalMs);
  }
  throw new ConnectorError(ErrorCode.PUBLISH_TIMEOUT, 'Media container is still processing; retry later', true);
}

/** A timeout, dropped connection or 5xx on `*_publish` may still have made the post public. */
export function isUncertainMetaPublishFailure(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError
    && [ErrorCode.PUBLISH_TIMEOUT, ErrorCode.PLATFORM_API_ERROR].includes(error.code);
}

/**
 * Same contract as the Discourse connector: the job stops at NEEDS_ACTION and
 * the operator checks the profile, then either marks it published or confirms
 * it is absent (reconcile-not-found), which queues one more attempt.
 */
export function uncertainMetaPublishResult(containerId: string, error: ConnectorError): PublishResult {
  return {
    externalId: `pending:${containerId}`,
    status: 'NEEDS_ACTION',
    metadata: {
      reconciliationRequired: true,
      submissionUncertain: true,
      containerId,
      originalErrorCode: error.code,
    },
  };
}
