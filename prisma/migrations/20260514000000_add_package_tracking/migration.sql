-- CreateEnum
CREATE TYPE "TrackingCarrier" AS ENUM ('IMILE', 'INJAZ');

-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'UNKNOWN');

-- CreateTable
CREATE TABLE "tracking_orders" (
    "id" TEXT NOT NULL,
    "tracking_number" TEXT NOT NULL,
    "carrier" "TrackingCarrier" NOT NULL,
    "status" "TrackingStatus" NOT NULL DEFAULT 'PENDING',
    "latest_event" TEXT,
    "latest_event_at" TIMESTAMP(3),
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "order_id" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" TEXT NOT NULL,
    "tracking_order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "raw_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracking_orders_tracking_number_key" ON "tracking_orders"("tracking_number");

-- CreateIndex
CREATE INDEX "tracking_orders_carrier_idx" ON "tracking_orders"("carrier");

-- CreateIndex
CREATE INDEX "tracking_orders_status_idx" ON "tracking_orders"("status");

-- CreateIndex
CREATE INDEX "tracking_orders_order_id_idx" ON "tracking_orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_events_tracking_order_id_description_occurred_at_key" ON "tracking_events"("tracking_order_id", "description", "occurred_at");

-- CreateIndex
CREATE INDEX "tracking_events_tracking_order_id_idx" ON "tracking_events"("tracking_order_id");

-- CreateIndex
CREATE INDEX "tracking_events_occurred_at_idx" ON "tracking_events"("occurred_at");

-- AddForeignKey
ALTER TABLE "tracking_orders" ADD CONSTRAINT "tracking_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_tracking_order_id_fkey" FOREIGN KEY ("tracking_order_id") REFERENCES "tracking_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
