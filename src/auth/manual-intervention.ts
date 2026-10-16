import { setTimeout as delay } from 'node:timers/promises';
import { stdin, stdout } from 'node:process';
import type { AuthIdentity } from './auth.types';

export class ManualInterventionError extends Error {
  constructor(public readonly reason: 'TIMEOUT' | 'CANCELLED' | 'NON_INTERACTIVE') {
    super(reason);
    this.name = 'ManualInterventionError';
  }
}

export interface ManualInterventionOptions extends AuthIdentity {
  type: string;
  timeout: number;
  signal?: AbortSignal;
  pollMs?: number;
  check: () => Promise<boolean>;
  notify?: (message: string) => void;
}

export async function waitForManualIntervention(options: ManualInterventionOptions): Promise<void> {
  const notify = options.notify ?? ((message: string) => stdout.write(`${message}\n`));
  notify(`[${options.platform}/${options.account}] ${options.type}\n`
    + `Trình duyệt đang mở. Hãy hoàn thành xác thực thủ công. Timeout: ${options.timeout}ms.\nĐang chờ xác thực...`);
  const deadline = Date.now() + options.timeout;
  const pollMs = Math.max(1000, Math.min(options.pollMs ?? 1500, 2000));
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new ManualInterventionError('CANCELLED');
    if (await options.check()) return;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal })
      .catch(() => { throw new ManualInterventionError('CANCELLED'); });
  }
  throw new ManualInterventionError('TIMEOUT');
}

let terminalInUse = false;

/** No readline echo, piped stdin, CLI argument, structured log or file fallback. */
export function readHiddenOtp(signal: AbortSignal, timeout: number): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || terminalInUse) {
    return Promise.reject(new ManualInterventionError('NON_INTERACTIVE'));
  }
  if (signal.aborted) return Promise.reject(new ManualInterventionError('CANCELLED'));
  terminalInUse = true;
  const previousRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  let code = '';
  stdout.write('Nhập OTP từ ứng dụng/extension Authenticator (ẩn ký tự):\n> ');
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      signal.removeEventListener('abort', onAbort);
      stdin.setRawMode(previousRaw);
      if (wasPaused) stdin.pause();
      terminalInUse = false;
      code = '';
      stdout.write('\n');
    };
    const onAbort = () => { cleanup(); reject(new ManualInterventionError('CANCELLED')); };
    const onData = (chunk: Buffer) => {
      // Process bytes directly; never write them to stdout.
      for (const byte of chunk) {
        if (byte === 3 || byte === 4 || byte === 27) { onAbort(); return; }
        if (byte === 13 || byte === 10) {
          if (/^[0-9A-Za-z-]{4,32}$/.test(code)) {
            const entered = code;
            cleanup();
            resolve(entered);
            return;
          }
          code = '';
          continue;
        }
        if (byte === 127 || byte === 8) code = code.slice(0, -1);
        else if (byte >= 32 && byte < 127 && code.length < 32) code += String.fromCharCode(byte);
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new ManualInterventionError('TIMEOUT')); }, timeout);
    signal.addEventListener('abort', onAbort, { once: true });
    stdin.on('data', onData);
    stdin.setRawMode(true);
    stdin.resume();
  });
}
