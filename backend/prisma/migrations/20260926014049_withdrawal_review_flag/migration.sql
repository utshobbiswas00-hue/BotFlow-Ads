-- AlterTable
ALTER TABLE "withdrawals" ADD COLUMN     "requires_review" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "withdrawals_requires_review_idx" ON "withdrawals"("requires_review");
