-- Track the bot's "Invite users via link" right on the channel row, so the
-- publisher panel can show the same three-permission checklist the Telegram
-- admin screen presents and clear the banner once every one of them is on.
--
-- New column, default false: existing rows read as "no right", which is the
-- truthful state until the next permission check (or a verify call) writes
-- the actual value.
ALTER TABLE "channels"
  ADD COLUMN "can_invite_users" BOOLEAN NOT NULL DEFAULT FALSE;
