-- AlterEnum
ALTER TYPE "TrackingCarrier" ADD VALUE 'OTHER';

-- AlterTable
ALTER TABLE "tracking_orders" ADD COLUMN "carrier_name" TEXT;
ALTER TABLE "tracking_orders" ADD COLUMN "product_name" TEXT;
ALTER TABLE "tracking_orders" ADD COLUMN "cod_created_at" TIMESTAMP(3);
