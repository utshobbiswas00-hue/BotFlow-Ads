-- CreateEnum
CREATE TYPE "CryptoTransferStatus" AS ENUM ('DETECTED', 'CREDITED', 'IGNORED');

-- CreateTable
CREATE TABLE "crypto_chain_transfers" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "amount_raw" TEXT NOT NULL,
    "price_usd_cents" INTEGER,
    "amount_cents" INTEGER,
    "block_number" BIGINT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "status" "CryptoTransferStatus" NOT NULL DEFAULT 'DETECTED',
    "deposit_id" TEXT,
    "note" TEXT,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credited_at" TIMESTAMP(3),

    CONSTRAINT "crypto_chain_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crypto_chain_transfers_deposit_id_key" ON "crypto_chain_transfers"("deposit_id");

-- CreateIndex
CREATE INDEX "crypto_chain_transfers_status_idx" ON "crypto_chain_transfers"("status");

-- CreateIndex
CREATE INDEX "crypto_chain_transfers_to_address_idx" ON "crypto_chain_transfers"("to_address");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_chain_transfers_network_tx_hash_key" ON "crypto_chain_transfers"("network", "tx_hash");

