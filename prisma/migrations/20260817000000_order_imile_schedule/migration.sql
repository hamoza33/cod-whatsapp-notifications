-- Track the last delivery date booked with iMile by the `reschedule_imile`
-- automation action, so a daily sweep doesn't re-book the same parcel on
-- every tick.
ALTER TABLE "orders" ADD COLUMN "imile_scheduled_date" TEXT;
ALTER TABLE "orders" ADD COLUMN "imile_scheduled_at" TIMESTAMP(3);
