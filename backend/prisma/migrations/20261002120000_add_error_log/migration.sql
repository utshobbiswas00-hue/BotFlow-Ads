-- CreateTable
CREATE TABLE "error_logs" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'ERROR',
    "source" TEXT NOT NULL,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "request_id" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "error_logs_created_at_idx" ON "error_logs"("created_at");

-- CreateIndex
CREATE INDEX "error_logs_source_created_at_idx" ON "error_logs"("source", "created_at");

-- CreateIndex
CREATE INDEX "error_logs_level_created_at_idx" ON "error_logs"("level", "created_at");

