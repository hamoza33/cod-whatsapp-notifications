-- Add EXPIRED to the TrackingStatus enum. EXPIRED is used to flag orders
-- that have been stuck in a non-terminal state (PENDING / IN_TRANSIT /
-- OUT_FOR_DELIVERY / EXCEPTION / UNKNOWN) for more than 30 days since
-- their `cod_created_at` timestamp. Postgres requires ALTER TYPE ... ADD
-- VALUE outside a transaction block, so this migration must be applied
-- on its own.
ALTER TYPE "TrackingStatus" ADD VALUE 'EXPIRED';
