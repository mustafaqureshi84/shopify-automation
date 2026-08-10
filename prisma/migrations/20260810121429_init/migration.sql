-- CreateTable
CREATE TABLE "Product" (
    "gid" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalInventory" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("gid")
);

-- CreateTable
CREATE TABLE "Variant" (
    "gid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "sku" TEXT,
    "price" DECIMAL(12,2),
    "inventoryItemId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("gid")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "productsSeen" INTEGER NOT NULL DEFAULT 0,
    "productsCreated" INTEGER NOT NULL DEFAULT 0,
    "productsUpdated" INTEGER NOT NULL DEFAULT 0,
    "productsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "productsDeleted" INTEGER NOT NULL DEFAULT 0,
    "variantsSeen" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_shopDomain_status_idx" ON "Product"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");

-- CreateIndex
CREATE INDEX "Product_lastSeenAt_idx" ON "Product"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Variant_productGid_idx" ON "Variant"("productGid");

-- CreateIndex
CREATE INDEX "Variant_sku_idx" ON "Variant"("sku");

-- CreateIndex
CREATE INDEX "Variant_shopDomain_idx" ON "Variant"("shopDomain");

-- CreateIndex
CREATE INDEX "SyncRun_shopDomain_startedAt_idx" ON "SyncRun"("shopDomain", "startedAt");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productGid_fkey" FOREIGN KEY ("productGid") REFERENCES "Product"("gid") ON DELETE CASCADE ON UPDATE CASCADE;
