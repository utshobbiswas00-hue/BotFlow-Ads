-- A policy check (the channel blocklist in the delivery path) can now fail closed,
-- which needs a code that says so: the ad was not published because the rule that
-- guards the post could not be read. Retryable, unlike the terminal codes.
--
-- Adding a value is safe on PostgreSQL 12+ inside the transactional migration runner
-- as long as the value is not USED in the same transaction, which is the case here.
ALTER TYPE "DeliveryErrorCode" ADD VALUE IF NOT EXISTS 'POLICY_CHECK_UNAVAILABLE';
