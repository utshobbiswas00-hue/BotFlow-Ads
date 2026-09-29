-- Weekly posting schedule per channel: weekday ("0" = Sunday) -> the
-- channel-local HH:mm times a sponsored post may go out at.
ALTER TABLE "channels" ADD COLUMN "posting_schedule" JSONB;
