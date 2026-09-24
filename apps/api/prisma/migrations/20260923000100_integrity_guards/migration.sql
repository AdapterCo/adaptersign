-- Garantias de integridade no próprio banco (não depender só da aplicação).
-- Triggers e CHECKs não são representáveis no schema.prisma; ficam versionados aqui.

-- ───────────── Tabelas append-only / imutáveis ─────────────
CREATE OR REPLACE FUNCTION adapter_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é append-only: operação % não permitida', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION adapter_forbid_mutation();

CREATE TRIGGER document_versions_immutable
  BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION adapter_forbid_mutation();

CREATE TRIGGER signatures_immutable
  BEFORE UPDATE OR DELETE ON "signatures"
  FOR EACH ROW EXECUTE FUNCTION adapter_forbid_mutation();

CREATE TRIGGER consents_immutable
  BEFORE UPDATE OR DELETE ON "consents"
  FOR EACH ROW EXECUTE FUNCTION adapter_forbid_mutation();

CREATE TRIGGER legal_text_versions_immutable
  BEFORE UPDATE OR DELETE ON "legal_text_versions"
  FOR EACH ROW EXECUTE FUNCTION adapter_forbid_mutation();

-- envelope_documents: o vínculo documento↔envelope é imutável; apenas os campos
-- final_* podem ser preenchidos uma única vez (na finalização).
CREATE OR REPLACE FUNCTION adapter_envelope_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "envelopes" e WHERE e.id = OLD.envelope_id AND e.status <> 'DRAFT') THEN
      RAISE EXCEPTION 'Documento de envelope não-rascunho não pode ser removido'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.envelope_id <> OLD.envelope_id
     OR NEW.document_version_id <> OLD.document_version_id
     OR NEW.original_sha256 <> OLD.original_sha256
     OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'Vínculo de documento do envelope é imutável'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.final_sha256 IS NOT NULL AND NEW.final_sha256 IS DISTINCT FROM OLD.final_sha256)
     OR (OLD.final_storage_key IS NOT NULL AND NEW.final_storage_key IS DISTINCT FROM OLD.final_storage_key) THEN
    RAISE EXCEPTION 'Arquivo final já registrado não pode ser substituído'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER envelope_documents_guard
  BEFORE UPDATE OR DELETE ON "envelope_documents"
  FOR EACH ROW EXECUTE FUNCTION adapter_envelope_documents_guard();

-- Envelope finalizado/cancelado/expirado/recusado é terminal.
CREATE OR REPLACE FUNCTION adapter_envelopes_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Envelopes não podem ser removidos' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Envelope em estado terminal (%) não pode mudar de status', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.public_validation_code <> OLD.public_validation_code THEN
    RAISE EXCEPTION 'Código público de validação é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER envelopes_terminal_guard
  BEFORE UPDATE OR DELETE ON "envelopes"
  FOR EACH ROW EXECUTE FUNCTION adapter_envelopes_terminal_guard();

-- ───────────── CHECK constraints ─────────────
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "document_versions_size_positive" CHECK ("size_bytes" > 0),
  ADD CONSTRAINT "document_versions_page_count_positive" CHECK ("page_count" > 0),
  ADD CONSTRAINT "document_versions_version_positive" CHECK ("version_number" >= 1);

ALTER TABLE "envelope_documents"
  ADD CONSTRAINT "envelope_documents_original_sha256_format" CHECK ("original_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "envelope_documents_final_sha256_format" CHECK ("final_sha256" IS NULL OR "final_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "envelope_documents_position_positive" CHECK ("position" >= 1);

ALTER TABLE "envelopes"
  ADD CONSTRAINT "envelopes_completed_has_timestamp" CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL),
  ADD CONSTRAINT "envelopes_cancelled_has_timestamp" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL),
  ADD CONSTRAINT "envelopes_expired_has_timestamp" CHECK ("status" <> 'EXPIRED' OR "expired_at" IS NOT NULL),
  ADD CONSTRAINT "envelopes_declined_has_timestamp" CHECK ("status" <> 'DECLINED' OR "declined_at" IS NOT NULL),
  ADD CONSTRAINT "envelopes_active_has_activation" CHECK ("status" = 'DRAFT' OR "activated_at" IS NOT NULL OR "status" = 'CANCELLED'),
  ADD CONSTRAINT "envelopes_reminder_positive" CHECK ("reminder_interval_hours" IS NULL OR "reminder_interval_hours" >= 1);

ALTER TABLE "signers"
  ADD CONSTRAINT "signers_signing_group_positive" CHECK ("signing_group" >= 1),
  ADD CONSTRAINT "signers_signed_has_timestamp" CHECK ("status" <> 'SIGNED' OR "signed_at" IS NOT NULL),
  ADD CONSTRAINT "signers_declined_has_timestamp" CHECK ("status" <> 'DECLINED' OR "declined_at" IS NOT NULL);

ALTER TABLE "authentication_challenges"
  ADD CONSTRAINT "authentication_challenges_attempts_range" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts");

ALTER TABLE "signatures"
  ADD CONSTRAINT "signatures_typed_requires_name" CHECK ("method" <> 'TYPED' OR "typed_name" IS NOT NULL),
  ADD CONSTRAINT "signatures_drawn_requires_asset" CHECK ("method" <> 'DRAWN' OR ("asset_storage_key" IS NOT NULL AND "asset_sha256" IS NOT NULL));

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_sequence_positive" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "audit_events_hash_format" CHECK ("event_hash" ~ '^[0-9a-f]{64}$' AND "previous_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "evidence_reports"
  ADD CONSTRAINT "evidence_reports_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "usage_records"
  ADD CONSTRAINT "usage_records_quantity_non_negative" CHECK ("quantity" >= 0);
