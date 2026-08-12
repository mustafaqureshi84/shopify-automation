-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("webhookId")
);

-- CreateTable
CREATE TABLE "WarehouseNotification" (
    "id" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessedEvent_topic_processedAt_idx" ON "ProcessedEvent"("topic", "processedAt");

-- CreateIndex
CREATE INDEX "WarehouseNotification_productGid_sentAt_idx" ON "WarehouseNotification"("productGid", "sentAt");
