-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING_REVIEW', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'FINANCE_MANAGER', 'SUPPORT_AGENT', 'ANALYST');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'INACTIVE', 'ATTENTION_REQUIRED');

-- CreateEnum
CREATE TYPE "ChannelCategory" AS ENUM ('NEWS', 'TECHNOLOGY', 'EDUCATION', 'ENTERTAINMENT', 'GAMING', 'BUSINESS', 'SHOPPING', 'DEALS', 'JOBS', 'SPORTS', 'CRYPTO', 'COMMUNITY', 'OTHER');

-- CreateEnum
CREATE TYPE "PricingModel" AS ENUM ('FIXED', 'CPM', 'CPC', 'HYBRID');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AdFormat" AS ENUM ('TEXT', 'IMAGE', 'IMAGE_TEXT', 'BUTTON');

-- CreateEnum
CREATE TYPE "PromotionTarget" AS ENUM ('CHANNEL', 'GROUP', 'BOT', 'WEBSITE', 'PRODUCT', 'SERVICE', 'APP', 'BRAND');

-- CreateEnum
CREATE TYPE "AdPostStatus" AS ENUM ('QUEUED', 'AWAITING_APPROVAL', 'PROCESSING', 'PUBLISHED', 'FAILED', 'SKIPPED', 'RETRYING', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "DeliveryJobStatus" AS ENUM ('PENDING', 'SCHEDULED', 'LOCKED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED', 'AWAITING_APPROVAL');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'CAMPAIGN_CHARGE', 'PUBLISHER_EARNING', 'WITHDRAWAL', 'REFUND', 'PLATFORM_FEE', 'REFERRAL_REWARD', 'MANUAL_ADJUSTMENT', 'ESCROW_HOLD', 'ESCROW_RELEASE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'PENDING', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketSenderType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SCAM', 'SPAM', 'MISLEADING', 'BROKEN_LINK', 'INAPPROPRIATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CAMPAIGN_APPROVED', 'CAMPAIGN_REJECTED', 'CAMPAIGN_STARTED', 'CAMPAIGN_COMPLETED', 'CAMPAIGN_PAUSED', 'BUDGET_LOW', 'NEW_AD_REQUEST', 'AD_PUBLISHED', 'EARNINGS_ADDED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_REJECTED', 'DEPOSIT_VERIFIED', 'CHANNEL_APPROVED', 'CHANNEL_REJECTED', 'CHANNEL_PERMISSION_PROBLEM', 'DELIVERY_FAILED', 'FRAUD_ALERT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "FraudType" AS ENUM ('CLICK_FLOOD', 'DUPLICATE_CLICK', 'SELF_CLICK', 'ABNORMAL_CTR', 'REFERRAL_ABUSE', 'MULTI_ACCOUNT', 'AUTOMATED_ACTIVITY', 'SUSPICIOUS_ACCOUNT');

-- CreateEnum
CREATE TYPE "FraudSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DeliveryErrorCode" AS ENUM ('BOT_NOT_ADMIN', 'MISSING_POST_PERMISSION', 'CHANNEL_NOT_FOUND', 'CHANNEL_UNAVAILABLE', 'TELEGRAM_API_ERROR', 'CHAT_WRITE_FORBIDDEN', 'RATE_LIMITED', 'BUDGET_EXHAUSTED', 'CHANNEL_SUSPENDED', 'PUBLISHER_REJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChannelHealthStatus" AS ENUM ('HEALTHY', 'ATTENTION_REQUIRED', 'RESTRICTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CategoryPolicy" AS ENUM ('ALLOWED', 'REVIEW_REQUIRED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CreativeVersionStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DeliveryEventType" AS ENUM ('CREATED', 'QUEUED', 'SCHEDULED', 'AWAITING_APPROVAL', 'APPROVED_BY_PUBLISHER', 'REJECTED_BY_PUBLISHER', 'EXPIRED', 'PUBLISHING', 'PUBLISHED', 'CHARGED', 'FAILED', 'RETRIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BlocklistScope" AS ENUM ('ADVERTISER', 'CAMPAIGN', 'CATEGORY', 'DOMAIN');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PREMIUM', 'BUSINESS');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliverySlotType" AS ENUM ('PAID', 'HOUSE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "language_code" TEXT,
    "photo_url" TEXT,
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_advertiser" BOOLEAN NOT NULL DEFAULT true,
    "is_publisher" BOOLEAN NOT NULL DEFAULT true,
    "referral_code" TEXT NOT NULL,
    "referred_by_id" TEXT,
    "total_earned_cents" INTEGER NOT NULL DEFAULT 0,
    "total_spent_cents" INTEGER NOT NULL DEFAULT 0,
    "total_withdrawn_cents" INTEGER NOT NULL DEFAULT 0,
    "total_deposited_cents" INTEGER NOT NULL DEFAULT 0,
    "premium_tier" "PlanTier" NOT NULL DEFAULT 'FREE',
    "premium_until" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "last_balance_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'MODERATOR',
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "available_cents" INTEGER NOT NULL DEFAULT 0,
    "reserved_cents" INTEGER NOT NULL DEFAULT 0,
    "pending_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "total_deposited_cents" INTEGER NOT NULL DEFAULT 0,
    "total_spent_cents" INTEGER NOT NULL DEFAULT 0,
    "total_earned_cents" INTEGER NOT NULL DEFAULT 0,
    "total_withdrawn_cents" INTEGER NOT NULL DEFAULT 0,
    "total_refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'COMPLETED',
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balance_before_cents" INTEGER,
    "balance_after_cents" INTEGER,
    "reference" TEXT NOT NULL,
    "reference_type" TEXT,
    "idempotency_key" TEXT,
    "campaign_id" TEXT,
    "channel_id" TEXT,
    "ad_post_id" TEXT,
    "withdrawal_id" TEXT,
    "deposit_id" TEXT,
    "earning_id" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "method" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "gateway_ref" TEXT,
    "gateway_txn_id" TEXT,
    "proof_url" TEXT,
    "sender_info" TEXT,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "note" TEXT,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "amount_cents" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL DEFAULT 0,
    "net_amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "method" TEXT NOT NULL,
    "account_details" JSONB,
    "account_masked" TEXT,
    "processed_by_id" TEXT,
    "processed_at" TIMESTAMP(3),
    "tx_ref" TEXT,
    "reject_reason" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_earnings" (
    "id" TEXT NOT NULL,
    "publisher_id" TEXT NOT NULL,
    "ad_post_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "gross_cents" INTEGER NOT NULL,
    "platform_fee_cents" INTEGER NOT NULL,
    "net_cents" INTEGER NOT NULL,
    "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "reward_cents" INTEGER NOT NULL DEFAULT 0,
    "rewarded_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "telegram_channel_id" BIGINT NOT NULL,
    "username" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "photo_url" TEXT,
    "invite_link" TEXT,
    "category" "ChannelCategory" NOT NULL DEFAULT 'OTHER',
    "language" TEXT DEFAULT 'en',
    "country" TEXT DEFAULT 'BD',
    "subscriber_count" INTEGER NOT NULL DEFAULT 0,
    "avg_views" INTEGER NOT NULL DEFAULT 0,
    "avg_post_performance" INTEGER NOT NULL DEFAULT 0,
    "total_posts_tracked" INTEGER NOT NULL DEFAULT 0,
    "status" "ChannelStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "admin_note" TEXT,
    "bot_is_admin" BOOLEAN NOT NULL DEFAULT false,
    "can_post_messages" BOOLEAN NOT NULL DEFAULT false,
    "can_edit_messages" BOOLEAN NOT NULL DEFAULT false,
    "can_delete_messages" BOOLEAN NOT NULL DEFAULT false,
    "last_permission_check" TIMESTAMP(3),
    "pricing_model" "PricingModel" NOT NULL DEFAULT 'FIXED',
    "ad_price_cents" INTEGER NOT NULL DEFAULT 0,
    "cpm_rate_cents" INTEGER NOT NULL DEFAULT 0,
    "publisher_cpm_rate_cents" INTEGER,
    "earning_model" TEXT NOT NULL DEFAULT 'FIXED',
    "paid_ad_share_percent" INTEGER,
    "cpc_rate_cents" INTEGER NOT NULL DEFAULT 0,
    "auto_approve_posts" BOOLEAN NOT NULL DEFAULT true,
    "accept_ads" BOOLEAN NOT NULL DEFAULT true,
    "min_ad_price_cents" INTEGER NOT NULL DEFAULT 0,
    "max_campaigns_per_hour" INTEGER NOT NULL DEFAULT 2,
    "health_status" "ChannelHealthStatus" NOT NULL DEFAULT 'HEALTHY',
    "max_posts_per_day" INTEGER NOT NULL DEFAULT 3,
    "min_hours_between_ads" INTEGER NOT NULL DEFAULT 4,
    "total_ads_published" INTEGER NOT NULL DEFAULT 0,
    "total_earned_cents" INTEGER NOT NULL DEFAULT 0,
    "approved_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_stats" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "subscribers" INTEGER NOT NULL DEFAULT 0,
    "avg_views" INTEGER NOT NULL DEFAULT 0,
    "posts_count" INTEGER NOT NULL DEFAULT 0,
    "views_total" INTEGER NOT NULL DEFAULT 0,
    "clicks_total" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "advertiser_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "promotion_target" "PromotionTarget" NOT NULL DEFAULT 'CHANNEL',
    "pricing_model" "PricingModel" NOT NULL DEFAULT 'FIXED',
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "budget_total_cents" INTEGER NOT NULL,
    "budget_spent_cents" INTEGER NOT NULL DEFAULT 0,
    "budget_reserved_cents" INTEGER NOT NULL DEFAULT 0,
    "platform_fee_percent" INTEGER NOT NULL DEFAULT 20,
    "frequency_per_channel" INTEGER NOT NULL DEFAULT 1,
    "category" "ChannelCategory",
    "estimated_reach_min" INTEGER,
    "estimated_reach_max" INTEGER,
    "reach_basis" TEXT,
    "plan_snapshot" JSONB,
    "is_house" BOOLEAN NOT NULL DEFAULT false,
    "house_owner_label" TEXT,
    "language" TEXT DEFAULT 'en',
    "targeting" JSONB NOT NULL DEFAULT '{}',
    "is_auto_targeting" BOOLEAN NOT NULL DEFAULT false,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_targets" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "format" "AdFormat" NOT NULL DEFAULT 'TEXT',
    "text" TEXT NOT NULL,
    "image_url" TEXT,
    "button_text" TEXT,
    "button_url" TEXT,
    "destination_url" TEXT,
    "tracking_slug" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "text_hash" TEXT,
    "image_hash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_jobs" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "ad_id" TEXT,
    "status" "DeliveryJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "publisher_approved_at" TIMESTAMP(3),
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "platform_fee_percent" INTEGER NOT NULL DEFAULT 20,
    "approval_expires_at" TIMESTAMP(3),
    "slot_type" "DeliverySlotType" NOT NULL DEFAULT 'PAID',
    "error_code" "DeliveryErrorCode",
    "error_message" TEXT,
    "queue_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_posts" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "ad_id" TEXT,
    "channel_id" TEXT NOT NULL,
    "publisher_id" TEXT NOT NULL,
    "delivery_job_id" TEXT,
    "telegram_message_id" BIGINT,
    "status" "AdPostStatus" NOT NULL DEFAULT 'QUEUED',
    "published_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "unique_clicks" INTEGER NOT NULL DEFAULT 0,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "billing_mode" TEXT,
    "view_source" TEXT,
    "views_synced_at" TIMESTAMP(3),
    "earning_model" TEXT,
    "cpm_earned_cents" INTEGER NOT NULL DEFAULT 0,
    "house_ad_id" TEXT,
    "publisher_earning_cents" INTEGER NOT NULL DEFAULT 0,
    "platform_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "error_code" "DeliveryErrorCode",
    "error_message" TEXT,
    "last_stats_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clicks" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "ad_post_id" TEXT,
    "campaign_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "user_id" TEXT,
    "telegram_user_id" BIGINT,
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,
    "country" TEXT,
    "is_unique" BOOLEAN NOT NULL DEFAULT true,
    "is_fraud" BOOLEAN NOT NULL DEFAULT false,
    "fraud_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impressions" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT,
    "ad_post_id" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'telegram_api',
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "assigned_to_id" TEXT,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "sender_id" TEXT,
    "sender_type" "TicketSenderType" NOT NULL DEFAULT 'USER',
    "body" TEXT NOT NULL,
    "attachment_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "ad_post_id" TEXT,
    "campaign_id" TEXT,
    "reason" "ReportReason" NOT NULL DEFAULT 'OTHER',
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "action_taken" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" "FraudType" NOT NULL,
    "severity" "FraudSeverity" NOT NULL DEFAULT 'MEDIUM',
    "entity_type" TEXT,
    "entity_id" TEXT,
    "details" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fraud_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_type" TEXT NOT NULL DEFAULT 'ADMIN',
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "link" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "value_type" TEXT NOT NULL DEFAULT 'string',
    "group" TEXT NOT NULL DEFAULT 'general',
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_delivery_logs" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "ad_post_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_creative_versions" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "CreativeVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "format" "AdFormat" NOT NULL DEFAULT 'TEXT',
    "text" TEXT NOT NULL,
    "image_url" TEXT,
    "button_text" TEXT,
    "button_url" TEXT,
    "destination_url" TEXT,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "change_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_creative_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_events" (
    "id" TEXT NOT NULL,
    "delivery_job_id" TEXT NOT NULL,
    "type" "DeliveryEventType" NOT NULL,
    "actor_type" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actor_id" TEXT,
    "message" TEXT,
    "error_code" "DeliveryErrorCode",
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_blocklist" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "scope" "BlocklistScope" NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publisher_blocklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_domains" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "reason" TEXT,
    "hard_block" BOOLEAN NOT NULL DEFAULT true,
    "channel_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_events" (
    "id" TEXT NOT NULL,
    "click_id" TEXT,
    "ad_id" TEXT,
    "ad_post_id" TEXT,
    "campaign_id" TEXT,
    "channel_id" TEXT,
    "source" TEXT,
    "event_name" TEXT,
    "value_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_policy_rules" (
    "id" TEXT NOT NULL,
    "category" "ChannelCategory" NOT NULL,
    "policy" "CategoryPolicy" NOT NULL DEFAULT 'ALLOWED',
    "note" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tier" "PlanTier" NOT NULL DEFAULT 'PREMIUM',
    "period" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "duration_days" INTEGER NOT NULL DEFAULT 30,
    "benefits" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "badge_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "tier" "PlanTier" NOT NULL DEFAULT 'PREMIUM',
    "price_paid_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "benefits" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "payment_reference" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "house_ads" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "button_text" TEXT,
    "button_url" TEXT,
    "links" JSONB DEFAULT '[]',
    "language" TEXT NOT NULL DEFAULT 'en',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "house_ads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "users_referred_by_id_idx" ON "users"("referred_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_user_id_key" ON "admin_users"("user_id");

-- CreateIndex
CREATE INDEX "admin_users_role_idx" ON "admin_users"("role");

-- CreateIndex
CREATE INDEX "admin_users_is_active_idx" ON "admin_users"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_type_idx" ON "transactions"("type");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "transactions_campaign_id_idx" ON "transactions"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_gateway_ref_key" ON "deposits"("gateway_ref");

-- CreateIndex
CREATE INDEX "deposits_user_id_created_at_idx" ON "deposits"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "deposits_status_idx" ON "deposits"("status");

-- CreateIndex
CREATE INDEX "deposits_method_idx" ON "deposits"("method");

-- CreateIndex
CREATE INDEX "withdrawals_user_id_created_at_idx" ON "withdrawals"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_earnings_ad_post_id_key" ON "publisher_earnings"("ad_post_id");

-- CreateIndex
CREATE INDEX "publisher_earnings_publisher_id_status_idx" ON "publisher_earnings"("publisher_id", "status");

-- CreateIndex
CREATE INDEX "publisher_earnings_channel_id_idx" ON "publisher_earnings"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_user_id_key" ON "referrals"("referred_user_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_id_status_idx" ON "referrals"("referrer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channels_telegram_channel_id_key" ON "channels"("telegram_channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_username_key" ON "channels"("username");

-- CreateIndex
CREATE INDEX "channels_status_idx" ON "channels"("status");

-- CreateIndex
CREATE INDEX "channels_category_idx" ON "channels"("category");

-- CreateIndex
CREATE INDEX "channels_country_language_idx" ON "channels"("country", "language");

-- CreateIndex
CREATE INDEX "channels_subscriber_count_idx" ON "channels"("subscriber_count");

-- CreateIndex
CREATE INDEX "channels_owner_id_idx" ON "channels"("owner_id");

-- CreateIndex
CREATE INDEX "channel_stats_date_idx" ON "channel_stats"("date");

-- CreateIndex
CREATE UNIQUE INDEX "channel_stats_channel_id_date_key" ON "channel_stats"("channel_id", "date");

-- CreateIndex
CREATE INDEX "campaigns_advertiser_id_status_idx" ON "campaigns"("advertiser_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaigns_start_at_idx" ON "campaigns"("start_at");

-- CreateIndex
CREATE INDEX "campaign_targets_channel_id_idx" ON "campaign_targets"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_targets_campaign_id_channel_id_key" ON "campaign_targets"("campaign_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_tracking_slug_key" ON "ads"("tracking_slug");

-- CreateIndex
CREATE INDEX "ads_campaign_id_is_active_idx" ON "ads"("campaign_id", "is_active");

-- CreateIndex
CREATE INDEX "delivery_jobs_status_scheduled_at_idx" ON "delivery_jobs"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "delivery_jobs_channel_id_idx" ON "delivery_jobs"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_campaign_id_channel_id_ad_id_key" ON "delivery_jobs"("campaign_id", "channel_id", "ad_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_posts_delivery_job_id_key" ON "ad_posts"("delivery_job_id");

-- CreateIndex
CREATE INDEX "ad_posts_campaign_id_idx" ON "ad_posts"("campaign_id");

-- CreateIndex
CREATE INDEX "ad_posts_channel_id_published_at_idx" ON "ad_posts"("channel_id", "published_at");

-- CreateIndex
CREATE INDEX "ad_posts_publisher_id_status_idx" ON "ad_posts"("publisher_id", "status");

-- CreateIndex
CREATE INDEX "ad_posts_status_idx" ON "ad_posts"("status");

-- CreateIndex
CREATE INDEX "clicks_ad_id_created_at_idx" ON "clicks"("ad_id", "created_at");

-- CreateIndex
CREATE INDEX "clicks_campaign_id_created_at_idx" ON "clicks"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "clicks_ad_post_id_idx" ON "clicks"("ad_post_id");

-- CreateIndex
CREATE INDEX "clicks_is_fraud_idx" ON "clicks"("is_fraud");

-- CreateIndex
CREATE INDEX "impressions_ad_post_id_captured_at_idx" ON "impressions"("ad_post_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_no_key" ON "support_tickets"("ticket_no");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_idx" ON "support_tickets"("user_id");

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_created_at_idx" ON "ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "reports"("status");

-- CreateIndex
CREATE INDEX "reports_ad_post_id_idx" ON "reports"("ad_post_id");

-- CreateIndex
CREATE INDEX "fraud_events_user_id_idx" ON "fraud_events"("user_id");

-- CreateIndex
CREATE INDEX "fraud_events_type_severity_idx" ON "fraud_events"("type", "severity");

-- CreateIndex
CREATE INDEX "fraud_events_resolved_idx" ON "fraud_events"("resolved");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE INDEX "settings_group_idx" ON "settings"("group");

-- CreateIndex
CREATE INDEX "channel_delivery_logs_channel_id_created_at_idx" ON "channel_delivery_logs"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "ad_creative_versions_ad_id_status_idx" ON "ad_creative_versions"("ad_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ad_creative_versions_ad_id_version_key" ON "ad_creative_versions"("ad_id", "version");

-- CreateIndex
CREATE INDEX "delivery_events_delivery_job_id_created_at_idx" ON "delivery_events"("delivery_job_id", "created_at");

-- CreateIndex
CREATE INDEX "delivery_events_type_idx" ON "delivery_events"("type");

-- CreateIndex
CREATE INDEX "publisher_blocklist_channel_id_idx" ON "publisher_blocklist"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_blocklist_channel_id_scope_value_key" ON "publisher_blocklist"("channel_id", "scope", "value");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_domains_domain_key" ON "blocked_domains"("domain");

-- CreateIndex
CREATE INDEX "blocked_domains_domain_idx" ON "blocked_domains"("domain");

-- CreateIndex
CREATE INDEX "conversion_events_campaign_id_occurred_at_idx" ON "conversion_events"("campaign_id", "occurred_at");

-- CreateIndex
CREATE INDEX "conversion_events_click_id_idx" ON "conversion_events"("click_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_policy_rules_category_key" ON "category_policy_rules"("category");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE INDEX "subscription_plans_is_active_sort_order_idx" ON "subscription_plans"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_payment_reference_key" ON "subscriptions"("payment_reference");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_expires_at_status_idx" ON "subscriptions"("expires_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "house_ads_code_key" ON "house_ads"("code");

-- CreateIndex
CREATE INDEX "house_ads_is_active_weight_idx" ON "house_ads"("is_active", "weight");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_ad_post_id_fkey" FOREIGN KEY ("ad_post_id") REFERENCES "ad_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_stats" ADD CONSTRAINT "channel_stats_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_posts" ADD CONSTRAINT "ad_posts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_posts" ADD CONSTRAINT "ad_posts_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_posts" ADD CONSTRAINT "ad_posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_posts" ADD CONSTRAINT "ad_posts_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_posts" ADD CONSTRAINT "ad_posts_delivery_job_id_fkey" FOREIGN KEY ("delivery_job_id") REFERENCES "delivery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_posts" ADD CONSTRAINT "ad_posts_house_ad_id_fkey" FOREIGN KEY ("house_ad_id") REFERENCES "house_ads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_ad_post_id_fkey" FOREIGN KEY ("ad_post_id") REFERENCES "ad_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impressions" ADD CONSTRAINT "impressions_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_ad_post_id_fkey" FOREIGN KEY ("ad_post_id") REFERENCES "ad_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_events" ADD CONSTRAINT "fraud_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_creative_versions" ADD CONSTRAINT "ad_creative_versions_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_job_id_fkey" FOREIGN KEY ("delivery_job_id") REFERENCES "delivery_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_blocklist" ADD CONSTRAINT "publisher_blocklist_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_domains" ADD CONSTRAINT "blocked_domains_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
