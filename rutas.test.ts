import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const metodos = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

interface Ruta {
  clave: string;
  ubicacion: string;
}

interface Registro {
  rutas: Ruta[];
  rutasNoResueltas: { expresion: string; ubicacion: string }[];
  usaServidorComun: boolean;
}

function claveRuta(metodo: string, ruta: string): string {
  return `${metodo.toUpperCase()} ${ruta.replace(/:([a-zA-Z0-9_]+)/g, '{$1}')}`;
}

function rutasDelCodigo(directorio: string): Registro {
  const registro: Registro = { rutas: [], rutasNoResueltas: [], usaServidorComun: false };
  for (const entrada of readdirSync(directorio, { recursive: true, withFileTypes: true })) {
    if (!entrada.isFile() || !entrada.name.endsWith('.ts')) continue;
    const archivo = join(entrada.parentPath, entrada.name);
    const fuente = ts.createSourceFile(
      archivo,
      readFileSync(archivo, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visitar(nodo: ts.Node): void {
      if (ts.isCallExpression(nodo)) {
        const expresion = nodo.expression;
        if (ts.isIdentifier(expresion) && expresion.text === 'crearServidor') {
          registro.usaServidorComun = true;
        }
        if (ts.isPropertyAccessExpression(expresion) && metodos.has(expresion.name.text)) {
          const receptor = expresion.expression;
          const nombre = ts.isIdentifier(receptor)
            ? receptor.text
            : ts.isPropertyAccessExpression(receptor)
              ? receptor.name.text
              : '';
          if (nombre === 'app' || nombre === 'router') {
            const ruta = nodo.arguments[0];
            // Express también usa app.get('opcion') para leer su configuración.
            if (ruta && nodo.arguments.length > 1) {
              const linea = fuente.getLineAndCharacterOfPosition(ruta.getStart(fuente)).line + 1;
              const ubicacion = `${relative(raiz, archivo).replaceAll('\\', '/')}:${linea}`;
              if (ts.isStringLiteralLike(ruta)) {
                registro.rutas.push({
                  clave: claveRuta(expresion.name.text, ruta.text),
                  ubicacion,
                });
              } else {
                registro.rutasNoResueltas.push({ expresion: ruta.getText(fuente), ubicacion });
              }
            }
          }
        }
      }
      ts.forEachChild(nodo, visitar);
    }
    visitar(fuente);
  }
  return registro;
}

const contratos = join(raiz, 'specs/openapi');
const servicios = join(raiz, 'services');
const registros = new Map(
  readdirSync(servicios, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(servicios, e.name, 'src')))
    .map((e) => [e.name, rutasDelCodigo(join(servicios, e.name, 'src'))]),
);
const esperado = new Map<string, Ruta[]>();
for (const archivo of readdirSync(contratos).filter((f) => f.endsWith('.yaml'))) {
  const spec = parse(readFileSync(join(contratos, archivo), 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const rutas = Object.entries(spec.paths ?? {}).flatMap(([ruta, definicion]) =>
    Object.keys(definicion)
      .filter((metodo) => metodos.has(metodo))
      .map((metodo) => ({ clave: claveRuta(metodo, ruta), ubicacion: `specs/openapi/${archivo}` })),
  );
  if (rutas.length > 0 || archivo !== 'comun.yaml') esperado.set(archivo.slice(0, -5), rutas);
}

const convenciones = readFileSync(join(raiz, 'docs/CONVENCIONES.md'), 'utf8');
const duenos = new Map(
  [...convenciones.matchAll(/^\|[^|]+\| `services\/([^/`]+)` \|[^|]+\| (\w+) \|$/gm)].map(
    ([, servicio, dueno]) => [servicio, dueno],
  ),
);

// Las diferencias de la entrega se documentan y se vigilan para detectar cambios en el inventario.
const diferenciasConocidas = new Map([
  ['enrutador', ['implementada sin operación OpenAPI: GET /health']],
]);
const registroComun = rutasDelCodigo(join(raiz, 'packages/comun/src'));
const rutasComunes = registroComun.rutas;
const candidatos = [...new Set([...registros.keys(), ...esperado.keys()])].sort();

describe.each(candidatos)('concordancia de rutas de %s', (servicio) => {
  it('compara operaciones documentadas y registradas en Express en ambos sentidos', () => {
    const codigo = registros.get(servicio);
    const contrato = esperado.get(servicio) ?? [];
    const dueno = duenos.get(servicio) ?? 'sin dueño en docs/CONVENCIONES.md';
    expect(codigo, `${servicio} (dueño ${dueno}): falta el servicio`).toBeDefined();
    if (!codigo) return;

    const rutas = [...codigo.rutas, ...(codigo.usaServidorComun ? rutasComunes : [])];
    const diferencias = [
      ...rutas
        .filter((r) => !contrato.some((op) => op.clave === r.clave))
        .map((r) => ({ mensaje: `implementada sin operación OpenAPI: ${r.clave}`, ...r })),
      ...contrato
        .filter((op) => !rutas.some((r) => r.clave === op.clave))
        .map((op) => ({ mensaje: `operación OpenAPI sin registro: ${op.clave}`, ...op })),
    ];

    const diagnostico = diferencias.map((d) => `${d.mensaje} (${d.ubicacion})`).join('\n');
    expect(
      diferencias.map((d) => d.mensaje).sort(),
      `${servicio} (dueño ${dueno})\n${diagnostico}`,
    ).toEqual(diferenciasConocidas.get(servicio) ?? []);

    // El enrutador monta login y registro solo para reenviar el 307 de Autenticación.
    // Son operaciones del contrato de Autenticación, no rutas de negocio del enrutador.
    const proxys307 = servicio === 'enrutador' ? ['RUTAS_CON_307'] : [];
    expect(
      codigo.rutasNoResueltas.map((ruta) => ruta.expresion).sort(),
      `${servicio} (dueño ${dueno}): rutas dinámicas en ${codigo.rutasNoResueltas.map((r) => r.ubicacion).join(', ')}`,
    ).toEqual(proxys307);
    expect(registroComun.rutasNoResueltas).toEqual([]);
  });
});
