-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "WebhookEvent" AS ENUM ('CAMPAIGN_APPROVED', 'CAMPAIGN_REJECTED', 'CAMPAIGN_STARTED', 'CAMPAIGN_COMPLETED', 'POST_PUBLISHED', 'POST_FAILED', 'BUDGET_LOW', 'CONVERSION_RECORDED', 'INVOICE_ISSUED', 'EARNINGS_SETTLED', 'CHANNEL_APPROVED', 'CHANNEL_REJECTED', 'TEST');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'EARNINGS_AVAILABLE';
ALTER TYPE "NotificationType" ADD VALUE 'SECURITY_ALERT';
ALTER TYPE "NotificationType" ADD VALUE 'INVOICE_READY';
ALTER TYPE "NotificationType" ADD VALUE 'CONVERSION_RECORDED';

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "health_checked_at" TIMESTAMP(3),
ADD COLUMN     "health_score" INTEGER NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "conversion_events" ADD COLUMN     "advertiser_id" TEXT,
ADD COLUMN     "api_key_id" TEXT,
ADD COLUMN     "dedupe_key" TEXT;

-- A bare `ADD COLUMN ... NOT NULL` with no default fails on any non-empty
-- table, which made this whole migration undeployable against a database
-- that already had conversion events. Backfill first: `id` is the primary
-- key, so it is unique and satisfies the unique index created below.
UPDATE "conversion_events" SET "dedupe_key" = "id" WHERE "dedupe_key" IS NULL;
ALTER TABLE "conversion_events" ALTER COLUMN "dedupe_key" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email" TEXT,
ADD COLUMN     "email_opt_in" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "email_verified_at" TIMESTAMP(3),
ADD COLUMN     "email_verify_sent_at" TIMESTAMP(3),
ADD COLUMN     "email_verify_token" TEXT;

-- CreateTable
CREATE TABLE "advertiser_api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[] DEFAULT ARRAY['READ']::"ApiKeyScope"[],
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advertiser_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret" TEXT NOT NULL,
    "events" "WebhookEvent"[] DEFAULT ARRAY[]::"WebhookEvent"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event" "WebhookEvent" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_status" INTEGER,
    "error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal_cents" INTEGER NOT NULL,
    "refund_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "line_items" JSONB NOT NULL DEFAULT '[]',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "user_agent_hash" TEXT,
    "device_label" TEXT,
    "country" TEXT,
    "is_new_device" BOOLEAN NOT NULL DEFAULT false,
    "alerted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "advertiser_api_keys_prefix_key" ON "advertiser_api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "advertiser_api_keys_key_hash_key" ON "advertiser_api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "advertiser_api_keys_user_id_revoked_at_idx" ON "advertiser_api_keys"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "webhook_endpoints_user_id_is_active_idx" ON "webhook_endpoints"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_user_id_period_start_idx" ON "invoices"("user_id", "period_start");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "login_events_user_id_created_at_idx" ON "login_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "login_events_user_id_ip_hash_idx" ON "login_events"("user_id", "ip_hash");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_events_dedupe_key_key" ON "conversion_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "conversion_events_advertiser_id_occurred_at_idx" ON "conversion_events"("advertiser_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "advertiser_api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertiser_api_keys" ADD CONSTRAINT "advertiser_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

