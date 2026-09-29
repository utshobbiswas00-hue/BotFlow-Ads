-- Make the per-channel hourly cap optional so it can mean "no publisher cap",
-- letting a premium advertiser's own entitlement apply. A publisher that sets
-- an explicit number keeps it (the entitlement never overrides it).

-- AlterTable
ALTER TABLE "channels" ALTER COLUMN "max_campaigns_per_hour" DROP NOT NULL,
ALTER COLUMN "max_campaigns_per_hour" DROP DEFAULT;

