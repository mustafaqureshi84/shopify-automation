-- CreateTable
CREATE TABLE "Order" (
    "gid" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "customerEmail" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("gid")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "gid" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "variantGid" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("gid")
);

-- CreateTable
CREATE TABLE "ErpPush" (
    "id" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'attempting',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "erpReference" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ErpPush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_shopDomain_shopifyCreatedAt_idx" ON "Order"("shopDomain", "shopifyCreatedAt");

-- CreateIndex
CREATE INDEX "Order_financialStatus_idx" ON "Order"("financialStatus");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderGid_idx" ON "OrderLineItem"("orderGid");

-- CreateIndex
CREATE INDEX "OrderLineItem_sku_idx" ON "OrderLineItem"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ErpPush_idempotencyKey_key" ON "ErpPush"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ErpPush_orderGid_status_idx" ON "ErpPush"("orderGid", "status");

-- CreateIndex
CREATE INDEX "ErpPush_status_startedAt_idx" ON "ErpPush"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderGid_fkey" FOREIGN KEY ("orderGid") REFERENCES "Order"("gid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpPush" ADD CONSTRAINT "ErpPush_orderGid_fkey" FOREIGN KEY ("orderGid") REFERENCES "Order"("gid") ON DELETE CASCADE ON UPDATE CASCADE;
