-- READY_FOR_REVIEW sits between PENDING and APPROVED: the bot has every
-- permission the publisher can grant, but the channel is not yet visible to
-- advertisers until a moderator (or admin) signs off.
ALTER TYPE "ChannelStatus" ADD VALUE 'READY_FOR_REVIEW' BEFORE 'APPROVED';

ALTER TABLE "channels" ADD COLUMN "submitted_for_review_at" TIMESTAMP(3);
