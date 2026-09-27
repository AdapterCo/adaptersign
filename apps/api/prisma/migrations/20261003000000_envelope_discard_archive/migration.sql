-- AlterTable
ALTER TABLE "envelopes" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "envelopes_organization_id_deleted_at_archived_at_idx" ON "envelopes"("organization_id", "deleted_at", "archived_at");


-- Só rascunhos podem ser descartados; só envelopes finalizados podem ser arquivados.
ALTER TABLE "envelopes"
  ADD CONSTRAINT "envelopes_deleted_only_draft" CHECK ("deleted_at" IS NULL OR "status" = 'DRAFT'),
  ADD CONSTRAINT "envelopes_archived_only_final" CHECK ("archived_at" IS NULL OR "status" IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED'));
