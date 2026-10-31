ALTER TABLE "extension_login_checks" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'configured';
ALTER TABLE "extension_login_checks" ADD COLUMN "tryFallback" BOOLEAN NOT NULL DEFAULT false;
