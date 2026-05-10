-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cod_created_at" TIMESTAMP(3),
ADD COLUMN     "cod_updated_at" TIMESTAMP(3),
ADD COLUMN     "product_price" TEXT,
ADD COLUMN     "product_quantity" TEXT;

-- CreateIndex
CREATE INDEX "orders_cod_created_at_idx" ON "orders"("cod_created_at");
