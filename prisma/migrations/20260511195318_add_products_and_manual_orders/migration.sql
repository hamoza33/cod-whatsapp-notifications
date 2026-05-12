-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "then_send_header_image_url" TEXT,
ADD COLUMN     "then_send_template_variables" JSONB;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "is_manual" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "cod_network_product_id" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "name_arabic" TEXT,
    "image_url" TEXT,
    "price" TEXT,
    "currency" TEXT,
    "product_type" TEXT,
    "product_status" TEXT,
    "store_url" TEXT,
    "raw_product_json" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_cod_network_product_id_key" ON "products"("cod_network_product_id");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "products_sku_idx" ON "products"("sku");
