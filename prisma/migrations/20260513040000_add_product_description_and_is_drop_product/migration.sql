-- AlterTable: Add description and is_drop_product to products
ALTER TABLE "products" ADD COLUMN "description" TEXT;
ALTER TABLE "products" ADD COLUMN "is_drop_product" BOOLEAN NOT NULL DEFAULT false;
