-- Medium's published rules prohibit automated/programmatic access and posting
-- without express written consent. Convert the catalog entry and all existing
-- Medium destinations back to the safe manual handoff flow.

-- Browser session state is no longer needed and should not remain available to
-- a future code path after this policy correction.
DELETE FROM "platform_credentials" AS credential
USING "platform_accounts" AS account, "platforms" AS platform
WHERE credential."platformAccountId" = account."id"
  AND account."platformId" = platform."id"
  AND platform."slug" = 'medium'
  AND account."settings"->>'browserRecipe' = 'medium';

UPDATE "platform_accounts" AS account
SET
  "settings" = (
    COALESCE(account."settings", '{}'::jsonb)
      - 'browserRecipe'
      - 'browserAutoSubmit'
  ) || '{"manualUrl":"https://medium.com/new-story"}'::jsonb,
  "status" = CASE
    WHEN account."enabled" THEN 'CONNECTED'::"AccountStatus"
    ELSE 'DISABLED'::"AccountStatus"
  END,
  "lastTestedAt" = NULL
FROM "platforms" AS platform
WHERE account."platformId" = platform."id"
  AND platform."slug" = 'medium';

UPDATE "platforms"
SET
  "connectorKey" = 'manual',
  "mode" = 'MANUAL'::"PlatformMode",
  "availability" = 'MANUAL_ONLY'::"PlatformAvailability",
  "defaultSettings" = '{"manualUrl":"https://medium.com/new-story"}'::jsonb,
  "docsUrl" = 'https://help.medium.com/hc/en-us/articles/213477928-Medium-Rules'
WHERE "slug" = 'medium';
