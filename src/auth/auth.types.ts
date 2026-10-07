import { RoleName } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: RoleName[];
  type: 'access';
}

export interface RefreshPayload {
  sub: string;
  sid: string;
  type: 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  roles: RoleName[];
}
