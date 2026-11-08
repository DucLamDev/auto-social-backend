export const WORKER_CRASH_UNCERTAIN_RESULT_CODE = 'WORKER_CRASH_UNCERTAIN_RESULT';

export const WORKER_CRASH_UNCERTAIN_RESULT_MESSAGE =
  'Worker stopped after publish began; verify the provider before publishing again';

/** The AI quality check held this job before anything was sent to the platform. */
export const CONTENT_REVIEW_REQUIRED_CODE = 'CONTENT_REVIEW_REQUIRED';

/** Database-side safety net for a process that can no longer renew its Redis lease. */
export const STALE_DELIVERY_AFTER_MS = 15 * 60_000;

/**
 * Extension results where the platform received the post: it waits for the platform's
 * moderators, or it was sent but the extension could not confirm it. Only these can be
 * confirmed as published (by hand or by the moderation sync); the others never left Chrome.
 */
export const SUBMITTED_EXTENSION_CODES = ['EXTENSION_MODERATION_PENDING', 'EXTENSION_SUBMIT_UNCONFIRMED'];
