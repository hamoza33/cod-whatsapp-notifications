-- AlterEnum: add NAQEL to TrackingCarrier
ALTER TYPE "TrackingCarrier" ADD VALUE IF NOT EXISTS 'NAQEL';

-- CreateTable: ImageLibrary
CREATE TABLE "image_library" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "media_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_library_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PinnedConversation
CREATE TABLE "pinned_conversations" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "pinned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pinned_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pinned_conversations_phone_number_key" ON "pinned_conversations"("phone_number");
