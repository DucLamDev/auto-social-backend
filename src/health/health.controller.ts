import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { RabbitMqService } from '../queue/rabbitmq.service';
import { ApiOkEnvelope, HealthContractDto, ReadinessContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly rabbit: RabbitMqService,
  ) {}

  @Get('health')
  @ApiOkEnvelope(HealthContractDto)
  health() { return { status: 'ok', service: 'social-publisher-api', timestamp: new Date().toISOString() }; }

  @Get('ready')
  @ApiOkEnvelope(ReadinessContractDto)
  async ready() {
    const [, redis, rabbitmq] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
      this.rabbit.ping(),
    ]);
    return { status: 'ready', database: 'up', redis: redis ? 'up' : 'down', rabbitmq: rabbitmq ? 'up' : 'down', timestamp: new Date().toISOString() };
  }
}
