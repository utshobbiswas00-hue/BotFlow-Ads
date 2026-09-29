-- The operator repriced the monthly plan from $5.00 to $15.00.
--
-- `seedDefaultPlans()` deliberately never overwrites a plan an admin has edited,
-- so an install that already created the default plans would keep the old price
-- forever. This corrects it once, and only while the row still holds the OLD
-- default — a price an admin has since chosen is left untouched.
UPDATE "subscription_plans"
   SET "price_cents" = 1500
 WHERE "code" = 'PREMIUM_MONTHLY'
   AND "price_cents" = 500;

-- A plan's term must match its billing period: 30 days monthly, 365 yearly.
--
-- `upsertPlan()` derives `duration_days` from `period` on every write, so this
-- only repairs a row that drifted, and only for the three built-in plans so a
-- custom plan is never re-termed. This is the guarantee behind "a one-month
-- package ends after one month; a one-year package after one year" — together
-- with `activeSubscription()`, which already filters on `expires_at > now()` so
-- entitlements stop at the exact instant of expiry even if the worker is down.
UPDATE "subscription_plans" SET "duration_days" = 30  WHERE "code" = 'PREMIUM_MONTHLY'  AND "duration_days" <> 30;
UPDATE "subscription_plans" SET "duration_days" = 365 WHERE "code" = 'PREMIUM_YEARLY'   AND "duration_days" <> 365;
UPDATE "subscription_plans" SET "duration_days" = 365 WHERE "code" = 'BUSINESS_YEARLY'  AND "duration_days" <> 365;
