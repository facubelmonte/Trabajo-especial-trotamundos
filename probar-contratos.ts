import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
const args = process.argv.slice(2);
if (args.some((argumento) => argumento !== '--en-vivo')) {
  process.stderr.write('Uso: npm run test:contratos [-- --en-vivo]\n');
  process.exit(1);
}

function correr(argumentos: string[], entorno: NodeJS.ProcessEnv = process.env): void {
  const resultado = spawnSync(process.execPath, argumentos, { stdio: 'inherit', env: entorno });
  if (resultado.error) throw resultado.error;
  if (resultado.status !== 0) process.exit(resultado.status ?? 1);
}

correr(['infra/scripts/lint-contratos.mjs']);
correr(['node_modules/vitest/vitest.mjs', 'run', 'contrato']);
if (args.includes('--en-vivo')) {
  correr(['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/e2e/vitest.config.ts'], {
    ...process.env,
    CONTRATOS_EN_VIVO: '1',
  });
}
