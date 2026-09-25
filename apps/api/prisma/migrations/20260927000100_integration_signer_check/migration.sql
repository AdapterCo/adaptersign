-- Migration separada: um valor novo de enum (AuthMethod.INTEGRATION) só pode ser usado
-- depois que a transação que o criou foi confirmada.

-- Assinatura pela integração exige a empresa representada.
ALTER TABLE "signers"
  ADD CONSTRAINT "signers_integration_representing" CHECK ("auth_method" <> 'INTEGRATION' OR "representing" IS NOT NULL);
