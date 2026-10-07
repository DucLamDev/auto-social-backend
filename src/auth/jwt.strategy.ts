import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../database/prisma.service';
import { JwtPayload, AuthenticatedUser } from './auth.types';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { HttpStatus } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') ?? 'development-access-secret-change-me-now',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'access') {
      throw new ApplicationException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Invalid token type',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!user?.enabled) {
      throw new ApplicationException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Account is unavailable',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles.map((entry) => entry.role.name),
    };
  }
}
