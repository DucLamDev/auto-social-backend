import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorOutboundHttpClient } from '../core/connector-outbound-http.client';
import { ConnectorAccount, PostPayload } from '../core/connector.types';
import { DiscourseConnector } from './discourse.connector';

const post: PostPayload = {
  title: 'A useful topic',
  body: 'A detailed Markdown body.',
  idempotencyKey: 'job-1',
};

const providerExternalId = 'sp-026ab639c21df8aa80e5789370a9db1b8b524b776fd8a0c';

const account: ConnectorAccount = {
  id: 'account-1',
  settings: {
    apiUsername: 'publisher',
    baseUrl: 'https://forum.example.com/',
    categoryId: '7',
  },
  credentials: { apiKey: 'secret-api-key' },
};

function guardedResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    text: text ?? '',
  };
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

describe('DiscourseConnector', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates a topic with header authentication and a numeric category', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({
        id: 101,
        post_number: 1,
        topic_id: 42,
        topic_slug: 'a-useful-topic',
      }));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: '42',
      url: 'https://forum.example.com/t/a-useful-topic/42',
      status: 'PUBLISHED',
      metadata: {
        categoryId: 7,
        providerExternalId,
        postId: 101,
        postNumber: 1,
      },
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://forum.example.com/posts.json');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Api-Key': 'secret-api-key',
        'Api-Username': 'publisher',
        'content-type': 'application/json',
      },
    });
    if (typeof init.body !== 'string') throw new Error('Expected a JSON string request body');
    expect(JSON.parse(init.body) as unknown).toEqual({
      title: post.title,
      raw: post.body,
      category: 7,
      external_id: providerExternalId,
    });
  });

  it('returns NEEDS_ACTION when Discourse puts the topic in moderation', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({
        success: true,
        action: 'enqueued',
        pending_post: { id: 77 },
      }));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        moderationQueue: true,
        providerExternalId,
        action: 'enqueued',
        pendingPostId: 77,
      },
    });
  });

  it('does not claim that a hidden reviewable topic is published', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({
        hidden: true,
        id: 101,
        reviewable_id: 55,
        topic_id: 42,
        topic_slug: 'awaiting-review',
      }));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: '42',
      url: 'https://forum.example.com/t/awaiting-review/42',
      status: 'NEEDS_ACTION',
      metadata: {
        moderationQueue: true,
        providerExternalId,
        reviewableId: 55,
        externalPostId: '42',
        url: 'https://forum.example.com/t/awaiting-review/42',
      },
    });
  });

  it('normalizes and deduplicates all comma-separated destination tags', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ topic_id: 42, topic_slug: 'tagged-topic' }));

    await new DiscourseConnector().publish({
      ...account,
      settings: {
        ...account.settings,
        defaultTags: ' #NodeJS, nodejs, ##NestJS, , #TypeScript, #API, #backend, #sixth',
      },
    }, post);

    const body = request.mock.calls[0]![1].body;
    if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
    expect(JSON.parse(body) as unknown).toMatchObject({
      tags: [
        { name: 'NodeJS' },
        { name: 'NestJS' },
        { name: 'TypeScript' },
        { name: 'API' },
        { name: 'backend' },
        { name: 'sixth' },
      ],
    });
  });

  it('supports destination tags configured as a string array', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ topic_id: 42 }));

    await new DiscourseConnector().publish({
      ...account,
      settings: { ...account.settings, defaultTags: [' #mongodb ', 'atlas'] },
    }, post);

    const body = request.mock.calls[0]![1].body;
    if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
    expect(JSON.parse(body) as unknown).toMatchObject({
      tags: [{ name: 'mongodb' }, { name: 'atlas' }],
    });
  });

  it('omits topic tags when destination tags normalize to no values', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ topic_id: 42 }));

    await new DiscourseConnector().publish({
      ...account,
      settings: { ...account.settings, defaultTags: [' ', '#', '### '] },
    }, post);

    const body = request.mock.calls[0]![1].body;
    if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tags');
  });

  it('does not map AI-generated hashtags when destination defaultTags are absent', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ topic_id: 42 }));

    await new DiscourseConnector().publish(account, {
      ...post,
      hashtags: ['ai-generated', 'possibly-nonexistent'],
    });

    const body = request.mock.calls[0]![1].body;
    if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tags');
  });

  it('derives a stable Discourse-safe external ID within the 50-character limit', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ topic_id: 42 }));

    await new DiscourseConnector().publish(account, {
      ...post,
      idempotencyKey: 'a'.repeat(64),
    });

    const body = request.mock.calls[0]![1].body;
    if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload.external_id).toEqual(expect.stringMatching(/^sp-[a-f0-9]{47}$/));
    expect(String(payload.external_id)).toHaveLength(50);
  });

  it('recovers a topic by external ID after Discourse rejects the duplicate create', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({ errors: ['external id taken'] }, 422))
      .mockResolvedValueOnce(guardedResponse({
        id: 42,
        slug: 'already-created',
        category_id: 7,
        visible: true,
        post_stream: { posts: [{ id: 101, post_number: 1, topic_id: 42 }] },
      }));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: '42',
      url: 'https://forum.example.com/t/already-created/42',
      status: 'PUBLISHED',
      metadata: {
        categoryId: 7,
        recoveredByExternalId: true,
        providerExternalId,
        postId: 101,
      },
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://forum.example.com/posts.json',
      `https://forum.example.com/t/external_id/${providerExternalId}.json`,
    ]);
  });

  it('preserves a Discourse subpath for create, recovery, and the returned topic URL', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({ errors: ['external id taken'] }, 422))
      .mockResolvedValueOnce(guardedResponse({
        id: 42,
        slug: 'mongodb-atlas-guide',
        category_id: 7,
        visible: true,
      }));
    const subpathAccount: ConnectorAccount = {
      ...account,
      settings: {
        ...account.settings,
        baseUrl: 'https://www.mongodb.com/community/forums/',
      },
    };

    await expect(new DiscourseConnector().publish(subpathAccount, post)).resolves.toMatchObject({
      externalId: '42',
      url: 'https://www.mongodb.com/community/forums/t/mongodb-atlas-guide/42',
      status: 'PUBLISHED',
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://www.mongodb.com/community/forums/posts.json',
      `https://www.mongodb.com/community/forums/t/external_id/${providerExternalId}.json`,
    ]);
  });

  it('keeps an ordinary validation rejection when no topic exists for the external ID', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({ errors: ['title is too short'] }, 422))
      .mockResolvedValueOnce(guardedResponse({ errors: ['not found'] }, 404));

    await expect(new DiscourseConnector().publish(account, post)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_CONTENT_REJECTED,
      retryable: false,
      safeDetails: { httpStatus: 422 },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['null', null],
    ['empty body', undefined],
    ['empty object', {}],
    ['non-object JSON', 'created'],
  ] as const)('requires reconciliation for a %s successful create response when lookup misses', async (_label, body) => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse(body))
      .mockResolvedValueOnce(guardedResponse({ error_type: 'not_found' }, 404));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: ErrorCode.PLATFORM_API_ERROR,
      },
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://forum.example.com/posts.json',
      `https://forum.example.com/t/external_id/${providerExternalId}.json`,
    ]);
  });

  it.each([
    [401, ErrorCode.PLATFORM_TOKEN_EXPIRED, false],
    [429, ErrorCode.PLATFORM_RATE_LIMITED, true],
    [422, ErrorCode.PLATFORM_CONTENT_REJECTED, false],
  ] as const)(
    'propagates external-ID lookup HTTP %s after a failed create',
    async (status, code, retryable) => {
      const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
        .mockResolvedValueOnce(guardedResponse({ errors: ['create rejected'] }, 422))
        .mockResolvedValueOnce(guardedResponse({ errors: ['lookup failed'] }, status));

      await expect(new DiscourseConnector().publish(account, post)).rejects.toMatchObject({
        code,
        retryable,
        safeDetails: { httpStatus: status },
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it('tests the authenticated user and configured category without creating a topic', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: {
          can_create_topic: true,
          name: 'Forum Publisher',
          username: 'publisher',
        },
      }))
      .mockResolvedValueOnce(guardedResponse({
        category: {
          id: 7,
          name: 'Guides',
          permission: 1,
          slug: 'guides',
        },
      }));

    await expect(new DiscourseConnector().testConnection(account)).resolves.toEqual({
      ok: true,
      accountName: 'publisher',
      details: {
        baseUrl: 'https://forum.example.com',
        categoryId: 7,
        displayName: 'Forum Publisher',
        categoryName: 'Guides',
        categorySlug: 'guides',
        categoryPermission: 1,
        canCreateTopic: true,
        configuredDefaultTagCount: 0,
        minimumRequiredTags: 0,
        requiredTagGroups: [],
        reportedTagCountLowerBound: 0,
        tagPolicyRequiresStagingVerification: false,
        configuredTagCountBelowReportedLowerBound: false,
      },
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://forum.example.com/session/current.json',
      'https://forum.example.com/c/7/show.json',
    ]);
    expect(request.mock.calls[0]![1].method).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['empty', undefined],
    ['array', []],
    ['primitive', 'authenticated'],
  ] as const)('rejects an invalid %s current-user response safely', async (_label, body) => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse(body));

    await expect(new DiscourseConnector().testConnection(account)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_API_ERROR,
      retryable: false,
      message: 'Discourse returned an invalid current-user response',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null', null],
    ['empty', undefined],
    ['array', []],
    ['primitive', 'category'],
  ] as const)('rejects an invalid %s category response safely', async (_label, body) => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse(body));

    await expect(new DiscourseConnector().testConnection(account)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_API_ERROR,
      retryable: false,
      message: 'Discourse returned an invalid category response',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects a category where the authenticated user cannot create topics', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse({
        category: { id: 7, permission: 2 },
      }));

    await expect(new DiscourseConnector().testConnection(account)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_PERMISSION_DENIED,
      retryable: false,
    });
  });

  it('rejects a category response that omits the full topic-creation permission', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse({ category: { id: 7 } }));

    await expect(new DiscourseConnector().testConnection(account)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_PERMISSION_DENIED,
      retryable: false,
    });
  });

  it('rejects an authenticated username that does not match the account settings', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({
        current_user: { can_create_topic: true, username: 'another-user' },
      }));

    await expect(new DiscourseConnector().testConnection(account)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_AUTH_FAILED,
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['false', false],
    ['missing', undefined],
  ] as const)('rejects when global can_create_topic is %s', async (_label, canCreateTopic) => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({
        current_user: {
          username: 'publisher',
          ...(canCreateTopic === undefined ? {} : { can_create_topic: canCreateTopic }),
        },
      }));

    await expect(new DiscourseConnector().testConnection(account)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_PERMISSION_DENIED,
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports category tag requirements when enough default tags are configured', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse({
        category: {
          id: 7,
          permission: 1,
          minimum_required_tags: '2',
          required_tag_groups: [{ name: 'Technology', min_count: 1 }],
        },
      }));

    await expect(new DiscourseConnector().testConnection({
      ...account,
      settings: { ...account.settings, defaultTags: ['nodejs', 'backend'] },
    })).resolves.toMatchObject({
      ok: true,
      details: {
        configuredDefaultTagCount: 2,
        minimumRequiredTags: 2,
        requiredTagGroups: [{ name: 'Technology', minCount: 1 }],
        reportedTagCountLowerBound: 2,
        tagPolicyRequiresStagingVerification: true,
        configuredTagCountBelowReportedLowerBound: false,
      },
    });
  });

  it('requires staging verification when tags are configured even without a published category policy', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse({
        category: { id: 7, permission: 1 },
      }));

    await expect(new DiscourseConnector().testConnection({
      ...account,
      settings: { ...account.settings, defaultTags: ['nodejs'] },
    })).resolves.toMatchObject({
      ok: true,
      details: {
        configuredDefaultTagCount: 1,
        tagPolicyRequiresStagingVerification: true,
        configuredTagCountBelowReportedLowerBound: false,
      },
    });
  });

  it.each([
    [
      'minimum_required_tags',
      { minimum_required_tags: 2 },
    ],
    [
      'required_tag_groups min_count',
      { minimum_required_tags: 0, required_tag_groups: [{ min_count: '2' }] },
    ],
  ] as const)('reports insufficient defaultTags for category %s without claiming policy validity', async (_label, requirements) => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse({
        category: { id: 7, permission: 1, ...requirements },
      }));

    await expect(new DiscourseConnector().testConnection({
      ...account,
      settings: { ...account.settings, defaultTags: ['only-one'] },
    })).resolves.toMatchObject({
      ok: true,
      details: {
        configuredDefaultTagCount: 1,
        reportedTagCountLowerBound: 2,
        tagPolicyRequiresStagingVerification: true,
        configuredTagCountBelowReportedLowerBound: true,
      },
    });
  });

  it('reports multiple required tag groups for staging verification without guessing membership', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({
        current_user: { can_create_topic: true, username: 'publisher' },
      }))
      .mockResolvedValueOnce(guardedResponse({
        category: {
          id: 7,
          permission: 1,
          required_tag_groups: [
            { name: 'Language', min_count: 1 },
            { name: 'Runtime', min_count: 2 },
          ],
        },
      }));

    await expect(new DiscourseConnector().testConnection({
      ...account,
      settings: { ...account.settings, defaultTags: ['nodejs', 'backend'] },
    })).resolves.toMatchObject({
      ok: true,
      details: {
        configuredDefaultTagCount: 2,
        requiredTagGroups: [
          { name: 'Language', minCount: 1 },
          { name: 'Runtime', minCount: 2 },
        ],
        reportedTagCountLowerBound: 2,
        tagPolicyRequiresStagingVerification: true,
        configuredTagCountBelowReportedLowerBound: false,
      },
    });
  });

  it.each([
    [401, ErrorCode.PLATFORM_TOKEN_EXPIRED, false],
    [403, ErrorCode.PLATFORM_PERMISSION_DENIED, false],
    [429, ErrorCode.PLATFORM_RATE_LIMITED, true],
  ] as const)('maps HTTP %s to %s without exposing the platform error', async (status, code, retryable) => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ errors: ['private platform detail'] }, status, {
        'retry-after': '13',
      }));

    let caught: unknown;
    try {
      await new DiscourseConnector().publish(account, post);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code, retryable });
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error('Expected a connector error');
    expect(caught.message).not.toContain('private platform detail');
  });

  it('requires reconciliation instead of retrying when create and lookup both time out', async () => {
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request').mockRejectedValue(timeout);

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: ErrorCode.PUBLISH_TIMEOUT,
        reconciliationLookupErrorCode: ErrorCode.PUBLISH_TIMEOUT,
      },
    });
  });

  it.each([
    ['a timeout', (() => { const error = new Error('request timed out'); error.name = 'TimeoutError'; return error; })(), ErrorCode.PUBLISH_TIMEOUT],
    ['HTTP 503', guardedResponse({ errors: ['temporarily unavailable'] }, 503), ErrorCode.PLATFORM_API_ERROR],
  ] as const)('requires reconciliation after %s when external-ID lookup still returns 404', async (_label, failure, code) => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request');
    if (failure instanceof Error) request.mockRejectedValueOnce(failure);
    else request.mockResolvedValueOnce(failure);
    request.mockResolvedValueOnce(guardedResponse({ error_type: 'not_found' }, 404));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: code,
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, ErrorCode.PLATFORM_TOKEN_EXPIRED],
    [403, ErrorCode.PLATFORM_PERMISSION_DENIED],
  ] as const)('requires reconciliation and flags account reconnect when lookup returns HTTP %s after an ambiguous create', async (status, code) => {
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(guardedResponse({ errors: ['lookup denied'] }, status));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: ErrorCode.PUBLISH_TIMEOUT,
        reconciliationLookupErrorCode: code,
        accountReconnectRequired: true,
      },
    });
  });

  it('does not turn a malformed successful create response into a retry when lookup times out', async () => {
    const timeout = new Error('lookup timed out');
    timeout.name = 'TimeoutError';
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValueOnce(guardedResponse({ success: true }))
      .mockRejectedValueOnce(timeout);

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: ErrorCode.PLATFORM_API_ERROR,
        reconciliationLookupErrorCode: ErrorCode.PUBLISH_TIMEOUT,
      },
    });
  });

  it('recovers by external ID immediately when the create response times out', async () => {
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(guardedResponse({
        id: 42,
        slug: 'created-before-timeout',
        category_id: 7,
        visible: true,
        post_stream: { posts: [{ id: 101, post_number: 1 }] },
      }));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toMatchObject({
      externalId: '42',
      url: 'https://forum.example.com/t/created-before-timeout/42',
      status: 'PUBLISHED',
      metadata: { recoveredByExternalId: true, providerExternalId },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid account configuration before making a request', async () => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request');
    const connector = new DiscourseConnector();

    await expect(connector.publish({
      ...account,
      settings: { ...account.settings, baseUrl: 'http://127.0.0.1', categoryId: 'not-a-number' },
    }, post)).rejects.toMatchObject({ code: ErrorCode.PLATFORM_AUTH_FAILED });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'https://forum.example.com/?',
    'https://forum.example.com/#',
    'https://forum.example.com/community?tenant=one',
    'https://forum.example.com/community#settings',
  ])('rejects a Discourse base URL containing query or fragment delimiters: %s', async (baseUrl) => {
    const request = jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request');

    await expect(new DiscourseConnector().publish({
      ...account,
      settings: { ...account.settings, baseUrl },
    }, post)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_AUTH_FAILED,
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('validates required content and rejects unsupported media', () => {
    const connector = new DiscourseConnector();
    expect(captureError(() => connector.validate({ ...post, title: ' ' }))).toMatchObject({
      code: ErrorCode.PLATFORM_CONTENT_REJECTED,
    });
    expect(captureError(() => connector.validate({
      ...post,
      media: [{ type: 'image', url: 'https://cdn.example.com/image.png' }],
    }))).toMatchObject({ code: ErrorCode.PLATFORM_MEDIA_INVALID });
  });

  it('requires reconciliation for an ambiguous response and malformed lookup instead of retrying', async () => {
    jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request')
      .mockResolvedValue(guardedResponse({ success: true }));

    await expect(new DiscourseConnector().publish(account, post)).resolves.toEqual({
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: ErrorCode.PLATFORM_API_ERROR,
        reconciliationLookupErrorCode: ErrorCode.PLATFORM_API_ERROR,
      },
    });
  });
});
