import { defineConfig } from 'vitest/config';

// Pruebas de extremo a extremo: corren contra el sistema levantado (npm run infra:levantar),
// usando solo las APIs públicas. Una prueba por caso de uso (UC-1 a UC-8).
export default defineConfig({
  test: {
    root: 'tests/e2e',
    include: ['**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    ...(process.env.CONTRATOS_EN_VIVO === '1' ? { globalSetup: ['./captura-contratos.ts'] } : {}),
  },
});
