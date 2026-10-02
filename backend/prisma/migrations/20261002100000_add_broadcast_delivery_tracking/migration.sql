-- CreateEnum
CREATE TYPE "BroadcastJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BroadcastAudience" AS ENUM ('ALL', 'PUBLISHERS', 'ADVERTISERS');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "broadcast_jobs" (
    "id" TEXT NOT NULL,
    "status" "BroadcastJobStatus" NOT NULL DEFAULT 'QUEUED',
    "audience" "BroadcastAudience" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "broadcast_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "telegram_message_id" BIGINT,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broadcast_jobs_created_at_idx" ON "broadcast_jobs"("created_at");

-- CreateIndex
CREATE INDEX "broadcast_jobs_status_idx" ON "broadcast_jobs"("status");

-- CreateIndex
CREATE INDEX "broadcast_recipients_job_id_status_idx" ON "broadcast_recipients"("job_id", "status");

-- CreateIndex
CREATE INDEX "broadcast_recipients_user_id_created_at_idx" ON "broadcast_recipients"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_recipients_job_id_user_id_key" ON "broadcast_recipients"("job_id", "user_id");

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "broadcast_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

