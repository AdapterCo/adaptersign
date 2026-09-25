-- CreateEnum
CREATE TYPE "PageCorner" AS ENUM ('BOTTOM_RIGHT', 'BOTTOM_LEFT', 'TOP_RIGHT', 'TOP_LEFT');

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "signing_mode" "SigningMode" NOT NULL DEFAULT 'SEQUENTIAL',
    "created_by_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "signing_group" INTEGER NOT NULL DEFAULT 1,
    "is_company" BOOLEAN NOT NULL DEFAULT false,
    "initials_all_pages" BOOLEAN NOT NULL DEFAULT false,
    "initials_corner" "PageCorner" NOT NULL DEFAULT 'BOTTOM_RIGHT',

    CONSTRAINT "template_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "templates_organization_id_archived_at_idx" ON "templates"("organization_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "templates_organization_id_key_key" ON "templates"("organization_id", "key");

-- CreateIndex
CREATE INDEX "template_roles_organization_id_idx" ON "template_roles"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_roles_template_id_key_key" ON "template_roles"("template_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "template_roles_template_id_position_key" ON "template_roles"("template_id", "position");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_roles" ADD CONSTRAINT "template_roles_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────── Garantias de integridade (não representáveis no schema.prisma) ─────────

-- Chaves usadas nas âncoras e pelas integrações: minúsculas, dígitos, "_" e "-".
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_key_format" CHECK ("key" ~ '^[a-z0-9][a-z0-9_-]{0,59}$');

ALTER TABLE "template_roles"
  ADD CONSTRAINT "template_roles_key_format" CHECK ("key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  ADD CONSTRAINT "template_roles_signing_group_positive" CHECK ("signing_group" >= 1),
  ADD CONSTRAINT "template_roles_position_non_negative" CHECK ("position" >= 0);
