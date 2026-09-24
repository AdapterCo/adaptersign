/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: false }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
    {
      // Requer PostgreSQL + Redis + S3 reais (ver docs/testing.md). Não roda sem infraestrutura.
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      moduleFileExtensions: ['ts', 'js', 'json'],
      testTimeout: 60000,
    },
  ],
};
