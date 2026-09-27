-- AlterTable
ALTER TABLE "billing_payments" ADD COLUMN     "pix_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "pix_payment_id" TEXT,
ADD COLUMN     "pix_qr_code" TEXT,
ADD COLUMN     "pix_qr_code_base64" TEXT;

