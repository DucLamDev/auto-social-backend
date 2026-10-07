import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersService } from './users.service';
import { AdminUserContractDto, ApiCreatedEnvelope, ApiOkEnvelope } from '../common/swagger/api-contract.dto';

@ApiTags('users')
@ApiBearerAuth()
@Roles(RoleName.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkEnvelope(AdminUserContractDto, true)
  list() {
    return this.users.list();
  }

  @Post()
  @ApiCreatedEnvelope(AdminUserContractDto)
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }
}
