-- AlterEnum
ALTER TYPE "AuthMethod" ADD VALUE 'INTEGRATION';

-- AlterEnum
ALTER TYPE "LegalTextKind" ADD VALUE 'COMPANY_SIGNATURE_AUTHORIZATION';

-- AlterTable
ALTER TABLE "envelopes" ADD COLUMN     "external_ref" TEXT,
ADD COLUMN     "template_id" UUID;

-- AlterTable
ALTER TABLE "signers" ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "representing" TEXT,
ADD COLUMN     "role_key" TEXT;

-- CreateTable
CREATE TABLE "company_signature_authorizations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "legal_text_version_id" UUID NOT NULL,
    "authorized_by_id" UUID NOT NULL,
    "authorized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,

    CONSTRAINT "company_signature_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_signature_authorizations_organization_id_revoked_at_idx" ON "company_signature_authorizations"("organization_id", "revoked_at");

-- CreateIndex
CREATE INDEX "envelopes_organization_id_external_ref_idx" ON "envelopes"("organization_id", "external_ref");

-- AddForeignKey
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_signature_authorizations" ADD CONSTRAINT "company_signature_authorizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_signature_authorizations" ADD CONSTRAINT "company_signature_authorizations_legal_text_version_id_fkey" FOREIGN KEY ("legal_text_version_id") REFERENCES "legal_text_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── Garantias de integridade (não representáveis no schema.prisma) ─────────

ALTER TABLE "envelopes"
  ADD CONSTRAINT "envelopes_external_ref_length" CHECK ("external_ref" IS NULL OR char_length("external_ref") BETWEEN 1 AND 120);

ALTER TABLE "signers"
  ADD CONSTRAINT "signers_role_key_format" CHECK ("role_key" IS NULL OR "role_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
