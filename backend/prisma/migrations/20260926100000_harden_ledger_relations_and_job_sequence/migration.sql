-- Harden the money path against data loss and against the delivery-job
-- uniqueness key silently collapsing repeat placements.
--
--   * ledger/billing relations become ON DELETE RESTRICT: deleting a user
--     can no longer erase transactions, deposits, withdrawals, earnings,
--     campaigns, channels or invoices.
--   * delivery_jobs.seq makes (campaign, channel, ad) repeatable so a
--     campaign with frequencyPerChannel = 3 keeps all 3 placements.
--   * an index matching the earnings release sweep (status, created_at).

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "deposits" DROP CONSTRAINT "deposits_user_id_fkey";

-- DropForeignKey
ALTER TABLE "withdrawals" DROP CONSTRAINT "withdrawals_user_id_fkey";

-- DropForeignKey
ALTER TABLE "publisher_earnings" DROP CONSTRAINT "publisher_earnings_publisher_id_fkey";

-- DropForeignKey
ALTER TABLE "publisher_earnings" DROP CONSTRAINT "publisher_earnings_ad_post_id_fkey";

-- DropForeignKey
ALTER TABLE "publisher_earnings" DROP CONSTRAINT "publisher_earnings_channel_id_fkey";

-- DropForeignKey
ALTER TABLE "channels" DROP CONSTRAINT "channels_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_advertiser_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_user_id_fkey";

-- DropIndex
DROP INDEX "delivery_jobs_campaign_id_channel_id_ad_id_key";

-- AlterTable
ALTER TABLE "delivery_jobs" ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "publisher_earnings_status_created_at_idx" ON "publisher_earnings"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_campaign_id_channel_id_ad_id_seq_key" ON "delivery_jobs"("campaign_id", "channel_id", "ad_id", "seq");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_ad_post_id_fkey" FOREIGN KEY ("ad_post_id") REFERENCES "ad_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
