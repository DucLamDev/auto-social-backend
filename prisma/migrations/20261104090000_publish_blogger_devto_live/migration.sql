-- An approved post now goes out live on Blogger and dev.to instead of as a draft
-- that had to be published by hand and then marked "Đã đăng". Accounts that
-- still carry the old catalog default are switched; saving drafts stays
-- available per account (Tài khoản → Đăng ngay / Lưu nháp).
UPDATE "platforms"
SET "defaultSettings" = jsonb_set("defaultSettings"::jsonb, '{publishImmediately}', 'true'::jsonb)
WHERE "slug" IN ('blogger', 'devto');

UPDATE "platform_accounts"
SET "settings" = jsonb_set("settings"::jsonb, '{publishImmediately}', 'true'::jsonb)
WHERE "platformId" IN (SELECT "id" FROM "platforms" WHERE "slug" IN ('blogger', 'devto'))
  AND "settings"::jsonb ->> 'publishImmediately' = 'false';
