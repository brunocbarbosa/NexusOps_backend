-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'ADMIN_MASTER';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "is_platform" BOOLEAN;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_is_platform_key" ON "tenants"("is_platform");

