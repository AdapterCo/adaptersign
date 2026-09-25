-- AlterTable
ALTER TABLE "signer_access_tokens" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'EMAIL';

-- AlterTable
ALTER TABLE "signature_sessions" ADD COLUMN     "link_channel" TEXT;


-- ───────── Garantias de integridade ─────────
ALTER TABLE "signer_access_tokens"
  ADD CONSTRAINT "signer_access_tokens_channel_valid" CHECK ("channel" IN ('EMAIL', 'WHATSAPP', 'API'));
ALTER TABLE "signature_sessions"
  ADD CONSTRAINT "signature_sessions_link_channel_valid" CHECK ("link_channel" IS NULL OR "link_channel" IN ('EMAIL', 'WHATSAPP', 'API'));
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_channel_valid" CHECK ("channel" IN ('EMAIL', 'WHATSAPP'));
