-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "pushesChecked" INTEGER NOT NULL DEFAULT 0,
    "agreed" INTEGER NOT NULL DEFAULT 0,
    "missingRemote" INTEGER NOT NULL DEFAULT 0,
    "resolvedUnknown" INTEGER NOT NULL DEFAULT 0,
    "confirmedFailed" INTEGER NOT NULL DEFAULT 0,
    "orphanedRemote" INTEGER NOT NULL DEFAULT 0,
    "repaired" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationRun_startedAt_idx" ON "ReconciliationRun"("startedAt");
