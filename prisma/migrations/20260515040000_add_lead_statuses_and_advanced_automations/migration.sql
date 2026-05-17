-- AlterEnum: add new lead statuses from COD Network dashboard
ALTER TYPE "OrderStatus" ADD VALUE 'NEW';
ALTER TYPE "OrderStatus" ADD VALUE 'NO_REPLY';
ALTER TYPE "OrderStatus" ADD VALUE 'WRONG';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "OrderStatus" ADD VALUE 'CALL_LATER';
ALTER TYPE "OrderStatus" ADD VALUE 'CANCELLED_PRICE';

-- AlterTable: add advanced automation condition fields
ALTER TABLE "automations" ADD COLUMN "and_phone_starts_with" TEXT;
ALTER TABLE "automations" ADD COLUMN "and_tracking_condition" TEXT;
ALTER TABLE "automations" ADD COLUMN "and_city_contains" TEXT;
ALTER TABLE "automations" ADD COLUMN "and_customer_name_contains" TEXT;
ALTER TABLE "automations" ADD COLUMN "and_min_price" TEXT;
ALTER TABLE "automations" ADD COLUMN "and_max_price" TEXT;
