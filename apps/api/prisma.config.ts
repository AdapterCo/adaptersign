import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 não carrega .env automaticamente; dotenv/config carrega o .env local (dev).
// Em produção as variáveis vêm do ambiente do container.
// `prisma generate` não conecta ao banco, mas exige DATABASE_URL definida
// (o Dockerfile e o CI definem um valor fictício na etapa de build).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
