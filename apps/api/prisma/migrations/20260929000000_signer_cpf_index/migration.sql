-- AlterTable
ALTER TABLE "signers" ADD COLUMN     "cpf_hash" TEXT;

-- CreateIndex
CREATE INDEX "signers_organization_id_cpf_hash_idx" ON "signers"("organization_id", "cpf_hash");

