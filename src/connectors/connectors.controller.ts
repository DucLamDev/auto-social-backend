import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConnectorRegistryService } from './core/connector-registry.service';
import { ApiOkEnvelope, ConnectorDescriptorContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('connectors')
@ApiBearerAuth()
@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly registry: ConnectorRegistryService) {}

  @Get()
  @ApiOkEnvelope(ConnectorDescriptorContractDto, true)
  list() {
    return this.registry.list();
  }
}
