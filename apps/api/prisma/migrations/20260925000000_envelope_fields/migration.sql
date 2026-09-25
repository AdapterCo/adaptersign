-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('SIGNATURE', 'INITIALS', 'NAME', 'DATE');

-- CreateTable
CREATE TABLE "envelope_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "envelope_document_id" UUID NOT NULL,
    "signer_id" UUID NOT NULL,
    "type" "FieldType" NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "envelope_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "envelope_fields_envelope_id_idx" ON "envelope_fields"("envelope_id");

-- CreateIndex
CREATE INDEX "envelope_fields_envelope_document_id_idx" ON "envelope_fields"("envelope_document_id");

-- CreateIndex
CREATE INDEX "envelope_fields_signer_id_idx" ON "envelope_fields"("signer_id");

-- AddForeignKey
ALTER TABLE "envelope_fields" ADD CONSTRAINT "envelope_fields_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "envelopes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_fields" ADD CONSTRAINT "envelope_fields_envelope_document_id_fkey" FOREIGN KEY ("envelope_document_id") REFERENCES "envelope_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_fields" ADD CONSTRAINT "envelope_fields_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "signers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Garantias de integridade (não representáveis no schema.prisma) ─────────

-- Coordenadas normalizadas dentro da página.
ALTER TABLE "envelope_fields"
  ADD CONSTRAINT "envelope_fields_page_positive" CHECK ("page" >= 1),
  ADD CONSTRAINT "envelope_fields_box_range" CHECK (
    "x" >= 0 AND "y" >= 0 AND "width" > 0 AND "height" > 0
    AND "x" + "width" <= 1.000001 AND "y" + "height" <= 1.000001
  );

-- Campos só podem ser criados, alterados ou removidos enquanto o envelope é rascunho.
CREATE OR REPLACE FUNCTION adapter_envelope_fields_guard() RETURNS trigger AS $$
DECLARE
  env_id UUID;
BEGIN
  env_id := COALESCE(NEW.envelope_id, OLD.envelope_id);
  IF EXISTS (SELECT 1 FROM "envelopes" e WHERE e.id = env_id AND e.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'Campos de envelope enviado são imutáveis'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER envelope_fields_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "envelope_fields"
  FOR EACH ROW EXECUTE FUNCTION adapter_envelope_fields_guard();
