export interface ReviewedBrowserRecipeManifestEntry {
  readonly key: string;
  readonly platformSlug: string;
  readonly engine: string;
  readonly revision: number;
  readonly allowedHosts: readonly string[];
  readonly finalSubmitPolicy: 'AUTOMATED' | 'HUMAN_REQUIRED';
  readonly requiresAutomationPermissionAttestation: boolean;
  readonly loginCaptureSupported: boolean;
  readonly mediaUploadSupported: boolean;
  readonly requiredAccountSettings: readonly string[];
}

/**
 * Security boundary for browser publishing. A recipe is available only after
 * both its code and its target host have been reviewed and added here.
 * Account JSON can select neither a new host nor an unreviewed recipe.
 */
export const REVIEWED_BROWSER_RECIPE_MANIFEST = [
  {
    key: 'voz-xenforo',
    platformSlug: 'voz-forums',
    engine: 'XENFORO_2',
    revision: 1,
    allowedHosts: ['voz.vn'],
    finalSubmitPolicy: 'AUTOMATED',
    requiresAutomationPermissionAttestation: true,
    loginCaptureSupported: true,
    mediaUploadSupported: false,
    requiredAccountSettings: [
      'forumPath',
      'automationPermissionAttested',
      'browserAutoSubmit',
    ],
  },
] as const satisfies readonly ReviewedBrowserRecipeManifestEntry[];

export function reviewedBrowserRecipeByKey(
  key: string,
): ReviewedBrowserRecipeManifestEntry | undefined {
  const normalized = key.trim().toLowerCase();
  return REVIEWED_BROWSER_RECIPE_MANIFEST.find((entry) => entry.key === normalized);
}

export function reviewedBrowserRecipeForPlatform(
  platformSlug: string,
): ReviewedBrowserRecipeManifestEntry | undefined {
  return REVIEWED_BROWSER_RECIPE_MANIFEST.find((entry) => entry.platformSlug === platformSlug);
}
