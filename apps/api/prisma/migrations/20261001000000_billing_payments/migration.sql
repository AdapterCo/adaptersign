-- CreateEnum
CREATE TYPE "BillingPaymentKind" AS ENUM ('PLAN', 'CREDITS');

-- CreateEnum
CREATE TYPE "BillingPaymentStatus" AS ENUM ('PENDING', 'IN_PROCESS', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "extra_document_credits" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "overage_bonus_percent" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "BillingPaymentKind" NOT NULL DEFAULT 'PLAN',
    "plan_id" UUID,
    "credit_pack_id" UUID,
    "documents" INTEGER,
    "created_by_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "BillingPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "period_months" INTEGER NOT NULL DEFAULT 1,
    "provider_checkout_id" TEXT,
    "provider_payment_id" TEXT,
    "payment_type" TEXT,
    "payment_method" TEXT,
    "status_detail" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_packs" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documents" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_packs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_provider_payment_id_key" ON "billing_payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "billing_payments_organization_id_created_at_idx" ON "billing_payments"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_payments_status_expires_at_idx" ON "billing_payments"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_packs_code_key" ON "credit_packs"("code");

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_credit_pack_id_fkey" FOREIGN KEY ("credit_pack_id") REFERENCES "credit_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── Garantias de integridade ─────────
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_extra_document_credits_non_negative" CHECK ("extra_document_credits" >= 0);
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_overage_bonus_percent_range" CHECK ("overage_bonus_percent" BETWEEN 0 AND 100);
ALTER TABLE "credit_packs"
  ADD CONSTRAINT "credit_packs_documents_positive" CHECK ("documents" > 0),
  ADD CONSTRAINT "credit_packs_price_positive" CHECK ("price_cents" > 0),
  ADD CONSTRAINT "credit_packs_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "billing_payments"
  ADD CONSTRAINT "billing_payments_amount_positive" CHECK ("amount_cents" > 0),
  ADD CONSTRAINT "billing_payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "billing_payments_period_months" CHECK ("period_months" BETWEEN 1 AND 12),
  -- Plano: exige o plano; pacote: exige o pacote e a quantidade.
  ADD CONSTRAINT "billing_payments_kind_fields" CHECK (
    ("kind" = 'PLAN' AND "plan_id" IS NOT NULL AND "credit_pack_id" IS NULL) OR
    ("kind" = 'CREDITS' AND "credit_pack_id" IS NOT NULL AND "documents" > 0)
  ),
  ADD CONSTRAINT "billing_payments_approved_at" CHECK ("status" <> 'APPROVED' OR "approved_at" IS NOT NULL),
  ADD CONSTRAINT "billing_payments_plan_period" CHECK ("kind" <> 'PLAN' OR "status" <> 'APPROVED' OR ("period_start" IS NOT NULL AND "period_end" IS NOT NULL));
