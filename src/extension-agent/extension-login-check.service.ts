import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { freshTotp } from '../auth/totp-provider';
import { object, sessionOf, sessionScope } from './extension-account-session.service';
import type { AuthenticatedDevice } from './extension-agent.service';
import { ExtensionAuthStepDto } from './extension-agent.dto';

@Injectable()
export class ExtensionLoginCheckService {
  constructor(private readonly prisma: PrismaService, private readonly credentials: CredentialsService) {}

  async deviceStatus(device: AuthenticatedDevice) {
    const checks = await this.prisma.extensionLoginCheck.findMany({ where: { deviceId: device.id, account: { ownerId: device.ownerId } },
      orderBy: { createdAt: 'desc' }, take: 250, select: { id: true, status: true, message: true, account: { select: { platform: { select: { name: true } } } } } });
    return { pending: checks.filter(c => c.status === 'QUEUED' || c.status === 'RUNNING').length, checks };
  }

  async list(ownerId: string) {
    const accounts = await this.prisma.platformAccount.findMany({ where: { ownerId },
      select: { id: true, name: true, settings: true, platform: { select: { name: true } },
        extensionLoginChecks: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { name: 'asc' } });
    return accounts.filter(a => object(object(a.settings).extensionImport).selected !== false && (object(a.settings).extensionImport || sessionOf(a.settings))).map(a => ({
      id: a.id, name: a.name, platform: a.platform.name, configured: Boolean(sessionOf(a.settings)), autoLogin: Boolean(sessionOf(a.settings)?.autoLogin),
      issues: object(object(a.settings).extensionImport).issues ?? [],
      deviceId: sessionOf(a.settings)?.deviceId, check: a.extensionLoginChecks[0] ?? null,
    }));
  }

  async queue(ownerId: string, accountIds?: string[], verifyOnly = false) {
    const batchId = randomUUID();
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 7302))::text`;
      const accounts = await tx.platformAccount.findMany({ where: { ownerId, ...(accountIds ? { id: { in: accountIds } } : {}) } });
      const activeDevices = new Set((await tx.extensionDevice.findMany({ where: { ownerId, revokedAt: null }, select: { id: true } })).map(d => d.id));
      const active = new Set((await tx.extensionLoginCheck.findMany({ where: { account: { ownerId }, status: { in: ['QUEUED', 'RUNNING'] } }, select: { platformAccountId: true } })).map(c => c.platformAccountId));
      let queued = 0;
      for (const account of accounts) {
        const auth = sessionOf(account.settings);
        if (!auth || object(object(account.settings).extensionImport).selected === false || !activeDevices.has(auth.deviceId) || active.has(account.id)) continue;
        await tx.extensionLoginCheck.create({ data: { batchId, platformAccountId: account.id, deviceId: auth.deviceId, verifyOnly } });
        queued++;
      }
      return { batchId, queued };
    });
  }

  async claim(device: AuthenticatedDevice, allowedOrigins?: string[]) {
    return this.prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${device.id}, 7303))::text`;
    await tx.extensionLoginCheck.updateMany({ where: { deviceId: device.id, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 2 * 60_000) } },
      data: { status: 'NEEDS_ACTION', message: 'Phiên kiểm tra bị gián đoạn; không tự thử lại mật khẩu.', finishedAt: new Date() } });
    const running = await tx.extensionLoginCheck.findMany({ where: { deviceId: device.id, status: 'RUNNING' }, include: { account: { select: { settings: true } } } });
    if (running.length >= 3) return null;
    const scopes = (settings: unknown, verifyOnly = false) => {
      const session = sessionOf(settings);
      if (!session) return [];
      return [sessionScope(settings), ...(session.allowedOrigins ?? []), ...(!verifyOnly && session.autoLogin && session.provider === 'google' ? ['https://accounts.google.com'] : [])];
    };
    const busyScopes = new Set(running.flatMap(check => scopes(check.account.settings, check.verifyOnly)));
    const pending = await tx.extensionLoginCheck.findMany({ where: { deviceId: device.id, status: 'QUEUED', account: { ownerId: device.ownerId } },
      include: { account: { include: { platform: true } } }, orderBy: { createdAt: 'asc' }, take: 200 });
    const check = pending.find(candidate => {
      const session = sessionOf(candidate.account.settings);
      if (scopes(candidate.account.settings, candidate.verifyOnly).some(scope => busyScopes.has(scope))) return false;
      if (!session || allowedOrigins === undefined) return true;
      const required = [session.origin, ...(session.allowedOrigins ?? []), ...(!candidate.verifyOnly && session.autoLogin && session.provider === 'google' ? ['https://accounts.google.com'] : [])];
      return required.every(origin => allowedOrigins.includes(origin));
    });
    if (!check) return null;
    const auth = sessionOf(check.account.settings);
    if (!auth || object(object(check.account.settings).extensionImport).selected === false || auth.deviceId !== device.id) {
      await tx.extensionLoginCheck.update({ where: { id: check.id }, data: { status: 'NEEDS_ACTION', message: 'Cấu hình phiên đã thay đổi.', finishedAt: new Date() } });
      return null;
    }
    const won = await tx.extensionLoginCheck.updateMany({ where: { id: check.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!won.count) return null;
    const target = object(object(check.account.settings).extensionLoginTarget);
    return { kind: 'LOGIN_CHECK', jobId: check.id, targetOrigin: auth.origin, openUrl: target.url ?? auth.origin,
      auth: check.verifyOnly ? { ...auth, autoLogin: false, autoTotp: false } : auth,
      account: { id: check.account.id, name: check.account.name, platform: check.account.platform.name },
      recipe: { engine: target.engine ?? object(check.account.settings).extensionEngine ?? 'generic', workflow: 'login' } };
    });
  }

  private async active(device: AuthenticatedDevice, id: string) {
    const check = await this.prisma.extensionLoginCheck.findFirst({ where: { id, deviceId: device.id, status: 'RUNNING', account: { ownerId: device.ownerId } }, include: { account: true } });
    const auth = check && sessionOf(check.account.settings);
    if (!check || !auth || auth.deviceId !== device.id) throw new NotFoundException('Active login check for this Chrome profile not found');
    return { check, auth };
  }

  async authStep(device: AuthenticatedDevice, id: string, dto: ExtensionAuthStepDto) {
    const { check, auth } = await this.active(device, id);
    if (check.verifyOnly) throw new BadRequestException('Session verification cannot request login credentials');
    let url: URL;
    try { url = new URL(dto.pageUrl); } catch { throw new BadRequestException('Invalid login URL'); }
    const allowed = auth.provider === 'google' ? ['https://accounts.google.com'] : [auth.origin, ...(auth.allowedOrigins ?? [])];
    if (!auth.autoLogin || url.username || url.password || !allowed.includes(url.origin)) throw new BadRequestException('Login origin does not match this account');
    if (dto.step === 'totp' && !auth.autoTotp) throw new BadRequestException('No TOTP configured');
    const secret = object((await this.credentials.resolve(check.platformAccountId)).extensionLogin);
    if (dto.step === 'identifier') return { username: secret.username };
    const field = dto.step === 'password' ? 'passwordIssuedAt' : 'totpIssuedAt';
    const reserved = await this.prisma.extensionLoginCheck.updateMany({ where: { id, deviceId: device.id, status: 'RUNNING', [field]: null }, data: { [field]: new Date() } });
    if (!reserved.count) throw new BadRequestException('Login step already attempted');
    if (dto.step === 'password') return { username: secret.username, password: secret.password };
    if (typeof secret.totpSecret !== 'string') throw new BadRequestException('No TOTP configured');
    return freshTotp(secret.totpSecret);
  }

  async result(device: AuthenticatedDevice, id: string, dto: { outcome: string; message?: string; detectedUsername?: string; googleBlocked?: boolean }) {
    const { check, auth } = await this.active(device, id);
    const success = dto.outcome === 'AUTHENTICATED';
    if (success && auth.discoverIdentity && !auth.profileUrl && !dto.detectedUsername?.trim()) throw new BadRequestException('No account identity was detected');
    const status = success ? 'AUTHENTICATED' : 'NEEDS_ACTION';
    const message = check.verifyOnly && dto.message?.includes('chưa bật tự đăng nhập hoặc còn thiếu thông tin xác thực')
      ? 'Chưa nhận diện được phiên đăng nhập sẵn có trong Chrome này. Mở nền tảng, đăng nhập đúng tài khoản rồi bấm “Tôi đã đăng nhập · Kiểm tra”. Lượt kiểm tra này không thử mật khẩu hoặc mã 2FA.'
      : dto.message;
    await this.prisma.$transaction(async tx => {
      await tx.extensionLoginCheck.update({ where: { id }, data: { status, message: message?.slice(0, 500) ?? null,
        detectedUsername: dto.detectedUsername?.slice(0, 200), finishedAt: new Date() } });
      // A Chrome login verifies only the Chrome delivery route. Never turn an
      // API/manual account green using a browser session check.
      const settings = object(check.account.settings);
      const autoConnect = settings.extensionAutoConnect === true && settings.extensionAutoSubmit === true && object(settings.extensionSetup).status === 'READY';
      if (settings.delivery === 'extension' && object(settings.extensionSetup).status === 'ACCESS_RESTRICTED') {
        await tx.platformAccount.update({ where: { id: check.platformAccountId }, data: { enabled: false, status: 'ERROR', lastTestedAt: new Date() } });
      } else if (settings.delivery === 'extension' && (check.account.enabled || autoConnect)) {
        await tx.platformAccount.update({ where: { id: check.platformAccountId }, data: {
          status: success ? 'CONNECTED' : 'RECONNECT_REQUIRED', lastTestedAt: new Date(),
          ...(success && autoConnect ? { enabled: true } : {}),
        } });
      }
      if (success && (auth.discoverIdentity || auth.allowIdentityByEmail) && dto.detectedUsername?.trim()) {
        const username = dto.detectedUsername.trim();
        await tx.platformAccount.update({ where: { id: check.platformAccountId }, data: { username,
          settings: { ...object(check.account.settings), extensionSession: { ...auth, expectedUsername: username, discoverIdentity: false,
            profileUrl: username.toLowerCase() === auth.expectedUsername.toLowerCase() ? auth.profileUrl : '' } } } });
      }
      if (!success && dto.googleBlocked && auth.provider === 'google') {
        const pending = await tx.extensionLoginCheck.findMany({ where: { batchId: check.batchId, deviceId: device.id, status: 'QUEUED' }, include: { account: { select: { settings: true } } } });
        const shared = pending.filter(candidate => {
          const session = sessionOf(candidate.account.settings);
          return session?.provider === 'google' && session.loginUsername.toLowerCase() === auth.loginUsername.toLowerCase();
        }).map(candidate => candidate.id);
        await tx.extensionLoginCheck.updateMany({ where: { id: { in: shared }, status: 'QUEUED' },
          data: { status: 'NEEDS_ACTION', message: 'Google cần xác minh ở một lần kiểm tra trước; đã dừng các lần đăng nhập dùng chung Google trong đợt này.', finishedAt: new Date() } });
      }
    });
    return { status };
  }
}
