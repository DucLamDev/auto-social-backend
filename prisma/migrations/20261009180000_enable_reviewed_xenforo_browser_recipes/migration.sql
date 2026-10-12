UPDATE "platforms"
SET
  "connectorKey" = 'browser-assisted',
  "mode" = 'BROWSER_ASSISTED',
  "availability" = 'CREDENTIAL_REQUIRED',
  "docsUrl" = 'https://voz.vn/help/terms/',
  "defaultSettings" = '{"browserRecipe":"voz-xenforo","forumPath":"","threadPrefixId":"","browserAutoSubmit":false,"automationPermissionAttested":false}'::jsonb
WHERE "slug" = 'voz-forums';

UPDATE "platform_accounts" AS account
SET
  "settings" = (account."settings" - 'manualUrl') || platform."defaultSettings",
  "status" = 'RECONNECT_REQUIRED',
  "lastTestedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "platforms" AS platform
WHERE account."platformId" = platform."id"
  AND platform."slug" = 'voz-forums';
