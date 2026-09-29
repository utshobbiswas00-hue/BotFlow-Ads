-- CreateTable
CREATE TABLE "crypto_deposit_addresses" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "memo" TEXT,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crypto_deposit_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crypto_deposit_addresses_network_key" ON "crypto_deposit_addresses"("network");

-- CreateIndex
CREATE INDEX "crypto_deposit_addresses_isActive_idx" ON "crypto_deposit_addresses"("isActive");
