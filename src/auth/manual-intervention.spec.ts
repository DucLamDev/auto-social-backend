import { EventEmitter } from 'node:events';
import { stdin, stdout } from 'node:process';
import { readHiddenOtp } from './manual-intervention';

jest.mock('node:process', () => ({
  stdin: Object.assign(new (jest.requireActual<typeof import('node:events')>('node:events').EventEmitter)(), {
    isTTY: true, isRaw: false, isPaused: () => true, setRawMode: jest.fn(), pause: jest.fn(), resume: jest.fn(),
  }),
  stdout: { isTTY: true, write: jest.fn() },
}));

describe('Hidden terminal OTP', () => {
  const input = stdin as unknown as EventEmitter & { isTTY: boolean; setRawMode: jest.Mock; pause: jest.Mock };
  afterEach(() => { input.isTTY = true; jest.clearAllMocks(); });
  it('accepts pasted code without echo and restores terminal', async () => {
    const result = readHiddenOtp(new AbortController().signal, 1000);
    input.emit('data', Buffer.from('123456\r'));
    await expect(result).resolves.toBe('123456');
    expect(JSON.stringify((stdout.write as jest.Mock).mock.calls)).not.toContain('123456');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.pause).toHaveBeenCalled();
  });
  it('supports backspace and rejects concurrent prompts', async () => {
    const result = readHiddenOtp(new AbortController().signal, 1000);
    await expect(readHiddenOtp(new AbortController().signal, 1000)).rejects.toMatchObject({ reason: 'NON_INTERACTIVE' });
    input.emit('data', Buffer.from('123457\x7f6\r'));
    await expect(result).resolves.toBe('123456');
  });
  it('refuses piped stdin', async () => {
    input.isTTY = false;
    await expect(readHiddenOtp(new AbortController().signal, 1000)).rejects.toMatchObject({ reason: 'NON_INTERACTIVE' });
  });
  it('cleans up on Ctrl+C', async () => {
    const result = readHiddenOtp(new AbortController().signal, 1000);
    input.emit('data', Buffer.from([3]));
    await expect(result).rejects.toMatchObject({ reason: 'CANCELLED' });
    expect(input.listenerCount('data')).toBe(0);
  });
  it('cleans up on abort and timeout', async () => {
    const abort = new AbortController();
    const result = readHiddenOtp(abort.signal, 1000);
    abort.abort();
    await expect(result).rejects.toMatchObject({ reason: 'CANCELLED' });
    await expect(readHiddenOtp(new AbortController().signal, 5)).rejects.toMatchObject({ reason: 'TIMEOUT' });
    expect(input.listenerCount('data')).toBe(0);
  });
});
