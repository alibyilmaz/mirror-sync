-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "plan" TEXT NOT NULL DEFAULT 'free',
    "rateAvailable" DOUBLE PRECISION,
    "rateMax" DOUBLE PRECISION,
    "rateRestoreRate" DOUBLE PRECISION,
    "rateUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "sourceShopId" TEXT NOT NULL,
    "destShopId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'importing',
    "pausedReason" TEXT,
    "syncInventory" BOOLEAN NOT NULL DEFAULT true,
    "syncTitle" BOOLEAN NOT NULL DEFAULT false,
    "syncPrice" BOOLEAN NOT NULL DEFAULT false,
    "syncImages" BOOLEAN NOT NULL DEFAULT false,
    "syncTags" BOOLEAN NOT NULL DEFAULT false,
    "metafieldNamespaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "safetyStockBuffer" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationLink" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sourceLocationId" BIGINT NOT NULL,
    "destLocationId" BIGINT NOT NULL,

    CONSTRAINT "LocationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mapping" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "sourceProductId" BIGINT,
    "sourceVariantId" BIGINT NOT NULL,
    "sourceInventoryItemId" BIGINT NOT NULL,
    "destProductId" BIGINT,
    "destVariantId" BIGINT NOT NULL,
    "destInventoryItemId" BIGINT NOT NULL,
    "matchType" TEXT NOT NULL DEFAULT 'auto_sku',
    "status" TEXT NOT NULL DEFAULT 'active',
    "pauseReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceVersion" (
    "shopDomain" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "version" TIMESTAMP(3) NOT NULL,
    "payloadHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceVersion_pkey" PRIMARY KEY ("shopDomain","resourceType","resourceKey")
);

-- CreateTable
CREATE TABLE "EchoWrite" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "valueHash" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EchoWrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetter" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dead',
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retriedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkImport" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "bulkOperationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "url" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BulkImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "PairingCode_code_key" ON "PairingCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_sourceShopId_destShopId_key" ON "Connection"("sourceShopId", "destShopId");

-- CreateIndex
CREATE UNIQUE INDEX "LocationLink_connectionId_sourceLocationId_key" ON "LocationLink"("connectionId", "sourceLocationId");

-- CreateIndex
CREATE INDEX "Mapping_connectionId_sourceInventoryItemId_idx" ON "Mapping"("connectionId", "sourceInventoryItemId");

-- CreateIndex
CREATE INDEX "Mapping_connectionId_status_idx" ON "Mapping"("connectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Mapping_connectionId_sourceVariantId_key" ON "Mapping"("connectionId", "sourceVariantId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_receivedAt_idx" ON "WebhookReceipt"("receivedAt");

-- CreateIndex
CREATE INDEX "EchoWrite_shopDomain_resourceType_resourceKey_writtenAt_idx" ON "EchoWrite"("shopDomain", "resourceType", "resourceKey", "writtenAt");

-- CreateIndex
CREATE INDEX "DeadLetter_status_failedAt_idx" ON "DeadLetter"("status", "failedAt");

-- CreateIndex
CREATE INDEX "AuditLog_shopDomain_createdAt_idx" ON "AuditLog"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_connectionId_createdAt_idx" ON "AuditLog"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "BulkImport_connectionId_side_idx" ON "BulkImport"("connectionId", "side");

-- AddForeignKey
ALTER TABLE "PairingCode" ADD CONSTRAINT "PairingCode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_sourceShopId_fkey" FOREIGN KEY ("sourceShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_destShopId_fkey" FOREIGN KEY ("destShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationLink" ADD CONSTRAINT "LocationLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkImport" ADD CONSTRAINT "BulkImport_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

