-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('HARDWARE', 'SOFTWARE', 'NETWORK', 'ACCESS', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "is_internal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "category" "TicketCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "closed_by_id" UUID,
ADD COLUMN     "number" INTEGER NOT NULL,
ADD COLUMN     "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "resolved_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ticket_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "filters" JSONB,
    "row_count" INTEGER,
    "content" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_tenant_id_requested_by_id_idx" ON "reports"("tenant_id", "requested_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_tenant_id_id_key" ON "reports"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_assignee_id_idx" ON "tickets"("tenant_id", "assignee_id");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_requester_id_idx" ON "tickets"("tenant_id", "requester_id");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_created_at_idx" ON "tickets"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_tenant_id_number_key" ON "tickets"("tenant_id", "number");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_closed_by_id_fkey" FOREIGN KEY ("tenant_id", "closed_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_requested_by_id_fkey" FOREIGN KEY ("tenant_id", "requested_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every tenant that already exists needs a counter row, because the
-- ticket-creation transaction increments an existing row rather than upserting
-- one. New companies get theirs in the same transaction that creates them
-- (CompaniesService.create); this is the one-off for the ones that predate the
-- table -- the platform tenant included, which costs one unused row and avoids a
-- special case in the code that reads it.
INSERT INTO "ticket_counters" ("tenant_id", "last_number")
SELECT "id", 0 FROM "tenants"
ON CONFLICT ("tenant_id") DO NOTHING;
