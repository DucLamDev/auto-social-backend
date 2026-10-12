export const WORKER_CRASH_UNCERTAIN_RESULT_CODE = 'WORKER_CRASH_UNCERTAIN_RESULT';

export const WORKER_CRASH_UNCERTAIN_RESULT_MESSAGE =
  'Worker stopped after publish began; verify the provider before publishing again';

/** Database-side safety net for a process that can no longer renew its Redis lease. */
export const STALE_DELIVERY_AFTER_MS = 15 * 60_000;
