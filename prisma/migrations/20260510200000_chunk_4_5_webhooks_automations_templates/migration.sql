-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cod_network_lead_id" TEXT,
ADD COLUMN     "cod_delivery_status" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_cod_network_lead_id_key" ON "orders"("cod_network_lead_id");

-- CreateIndex
CREATE INDEX "orders_cod_network_lead_id_idx" ON "orders"("cod_network_lead_id");

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'UTILITY',
    "body_param_count" INTEGER NOT NULL DEFAULT 0,
    "body_text" TEXT,
    "header_type" TEXT,
    "components" JSONB NOT NULL,
    "last_fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_name_language_key" ON "whatsapp_templates"("name", "language");

-- CreateIndex
CREATE INDEX "whatsapp_templates_status_idx" ON "whatsapp_templates"("status");

-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "when_status_equals" "OrderStatus",
    "and_product_contains" TEXT,
    "and_product_does_not_contain" TEXT,
    "then_move_to_status" "OrderStatus",
    "then_send_template_name" TEXT,
    "then_send_template_language" TEXT,
    "then_send_once" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_is_enabled_idx" ON "automations"("is_enabled");

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "moved_from_status" TEXT,
    "moved_to_status" TEXT,
    "sent_message" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_automation_id_order_id_key" ON "automation_runs"("automation_id", "order_id");

-- CreateIndex
CREATE INDEX "automation_runs_order_id_idx" ON "automation_runs"("order_id");

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
