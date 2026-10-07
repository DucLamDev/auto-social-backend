import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { sha256 } from '../common/utils/crypto.utils';
import { AuthenticatedUser, JwtPayload, RefreshPayload } from './auth.types';

interface RequestMetadata {
  userAgent?: string;
  ipAddress?: string;
}

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string, metadata: RequestMetadata): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { roles: { include: { role: true } } },
    });
    if (!user?.enabled || !(await compare(password, user.passwordHash))) {
      throw new ApplicationException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Email or password is incorrect',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(
      {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles.map((entry) => entry.role.name),
      },
      metadata,
    );
  }

  async refresh(token: string, metadata: RequestMetadata): Promise<AuthResult> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(token, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new ApplicationException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Refresh token is invalid or expired',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (payload.type !== 'refresh') {
      throw new ApplicationException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Invalid token type',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const session = await this.prisma.refreshTokenSession.findUnique({
      where: { id: payload.sid },
      include: { user: { include: { roles: { include: { role: true } } } } },
    });
    if (
      !session ||
      session.tokenHash !== sha256(token) ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      !session.user.enabled
    ) {
      throw new ApplicationException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Refresh session is no longer valid',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const revoked = await this.prisma.refreshTokenSession.updateMany({
      where: {
        id: session.id,
        tokenHash: sha256(token),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) {
      throw new ApplicationException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Refresh session is no longer valid',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.issueTokens(
      {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
        roles: session.user.roles.map((entry) => entry.role.name),
      },
      metadata,
    );
  }

  async logout(token?: string): Promise<void> {
    if (!token) return;
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(token, { secret: this.refreshSecret });
      await this.prisma.refreshTokenSession.updateMany({
        where: { id: payload.sid, tokenHash: sha256(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Logout is idempotent: an invalid/expired token is already effectively logged out.
    }
  }

  private async issueTokens(user: AuthenticatedUser, metadata: RequestMetadata): Promise<AuthResult> {
    const sessionId = randomUUID();
    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      type: 'access',
    };
    const refreshPayload: RefreshPayload = { sub: user.id, sid: sessionId, type: 'refresh' };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.accessSecret,
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '15m') as JwtSignOptions['expiresIn'],
    });
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.refreshSecret,
      expiresIn: this.config.get<string>('JWT_REFRESH_TTL', '30d') as JwtSignOptions['expiresIn'],
    });
    const decoded = this.jwt.decode<{ exp?: number }>(refreshToken);
    const expiresAt = new Date((decoded.exp ?? Math.floor(Date.now() / 1000) + 2_592_000) * 1000);
    await this.prisma.refreshTokenSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt,
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
      },
    });
    return { accessToken, refreshToken, user };
  }

  private get accessSecret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET') ?? 'development-access-secret-change-me-now';
  }

  private get refreshSecret(): string {
    return this.config.get<string>('JWT_REFRESH_SECRET') ?? 'development-refresh-secret-change-me';
  }
}
