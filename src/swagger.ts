import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Social Publisher API')
    .setDescription('REST contract for content ingestion, AI variants, campaigns, and social publishing')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controller, method) => `${controller.replace(/Controller$/, '')}_${method}`,
  });
  const errorSchema = {
    type: 'object' as const,
    required: ['success', 'error', 'meta'],
    properties: {
      success: { type: 'boolean' as const, example: false },
      error: {
        type: 'object' as const,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' as const },
          message: { type: 'string' as const },
          details: {},
        },
      },
      meta: {
        type: 'object' as const,
        required: ['requestId', 'timestamp'],
        properties: {
          requestId: { type: 'string' as const },
          timestamp: { type: 'string' as const, format: 'date-time' },
        },
      },
    },
  };
  for (const path of Object.values(document.paths)) {
    for (const candidate of Object.values(path ?? {}) as unknown[]) {
      if (!isRecord(candidate) || !isRecord(candidate.responses)) continue;
      candidate.responses.default ??= {
        description: 'Standard application error envelope',
        content: { 'application/json': { schema: errorSchema } },
      };
    }
  }
  return document;
}

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = createOpenApiDocument(app);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });
  return document;
}
