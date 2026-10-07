import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        displayName: true,
        enabled: true,
        lastLoginAt: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateUserDto) {
    const passwordHash = await hash(dto.password, 12);
    return this.prisma.user.create({
      data: {
        email: dto.email.trim().toLowerCase(),
        displayName: dto.displayName.trim(),
        passwordHash,
        roles: {
          create: dto.roles.map((name) => ({ role: { connect: { name } } })),
        },
      },
      select: { id: true, email: true, displayName: true, enabled: true, createdAt: true },
    });
  }
}
