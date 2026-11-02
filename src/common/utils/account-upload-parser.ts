import { BadRequestException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 500;

/**
 * Runs scripts/parse-account-upload.py. The file bytes go through stdin, never
 * a shell command or a temporary file; the JSON on stdout is private IPC that
 * may contain secrets and is never logged.
 */
export function runAccountUploadParser(
  buffer: Buffer,
  extension: string,
  mode: 'login' | 'api',
  failureMessage: string,
  isRow: (row: unknown) => boolean,
): Promise<unknown[]> {
  if (!['xlsx', 'csv', 'tsv'].includes(extension) || buffer.length > MAX_UPLOAD_BYTES) {
    throw new BadRequestException('Chọn file XLSX, CSV hoặc TSV tối đa 2 MiB.');
  }
  return new Promise((done, reject) => {
    const args = [resolve('scripts/parse-account-upload.py'), extension, ...(mode === 'api' ? ['api'] : [])];
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(new BadRequestException(failureMessage)); } };
    const timer = setTimeout(fail, 10_000);
    child.on('error', fail); child.stdin.on('error', fail);
    child.stderr.on('data', () => { /* Parser errors contain no cell values. */ });
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 8 * 1024 * 1024) fail(); });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return fail();
      try {
        const rows: unknown = JSON.parse(output);
        if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS || !rows.every(isRow)) return fail();
        settled = true; clearTimeout(timer); done(rows);
      } catch { fail(); }
    });
    child.stdin.end(buffer);
  });
}
