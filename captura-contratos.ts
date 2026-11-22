import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as esperar } from 'node:timers/promises';
import { Ajv, type ValidateFunction } from 'ajv';
import formatos from 'ajv-formats';
import { parse } from 'yaml';
import { PROYECTOS } from '../../infra/scripts/entorno.ts';

const urlAsyncApi = new URL('../../specs/asyncapi/eventos.yaml', import.meta.url);
const convenciones = readFileSync(new URL('../../docs/CONVENCIONES.md', import.meta.url), 'utf8');
const dueños = new Map(
  [...convenciones.matchAll(/^\|[^|]+\| `services\/([^/`]+)` \|[^|]+\| (\w+) \|$/gm)].map(
    ([, servicio, dueño]) => [servicio, dueño],
  ),
);
const contrato = parse(readFileSync(urlAsyncApi, 'utf8')) as {
  channels: Record<string, { address: string }>;
  operations: Record<
    string,
    { action: string; channel: { $ref: string }; 'x-servicio': string | string[] }
  >;
};

const ajv = new Ajv({ allErrors: true });
formatos.default(ajv);
function cargarEsquema(nombre: string): object {
  return JSON.parse(
    readFileSync(new URL(`../../specs/schemas/${nombre}.json`, import.meta.url), 'utf8'),
  ) as object;
}
ajv.addSchema(cargarEsquema('Sobre'), 'Sobre.json');
const validadores = new Map<string, ValidateFunction>();
const publicadores = new Map<string, string[]>();
for (const [id, canal] of Object.entries(contrato.channels)) {
  const productores = Object.values(contrato.operations)
    .filter((op) => op.action === 'send' && op.channel.$ref === `#/channels/${id}`)
    .flatMap((op) => op['x-servicio']);
  publicadores.set(canal.address, productores);
  ajv.addSchema(cargarEsquema(canal.address), `${canal.address}.json`);
  validadores.set(
    canal.address,
    ajv.compile({
      allOf: [
        { $ref: 'Sobre.json' },
        {
          type: 'object',
          properties: { tipo: { const: canal.address }, datos: { $ref: `${canal.address}.json` } },
        },
      ],
    }),
  );
}

// El broker solo escucha en la red privada de Compose. Se reutiliza la conexión configurada en el
// contenedor de Viajes para escuchar desde una cola exclusiva que recibe copias de los eventos.
const capturador = `
  import { connect } from 'amqplib';
  const conexion = await connect(process.env.URL_BROKER);
  conexion.on('error', () => process.exit(1));
  conexion.on('close', () => process.exit(1));
  const canal = await conexion.createChannel();
  await canal.checkExchange('trotamundos.eventos');
  const { queue } = await canal.assertQueue('', {
    exclusive: true, autoDelete: true, arguments: { 'x-queue-type': 'classic' },
  });
  await canal.bindQueue(queue, 'trotamundos.eventos', '#');
  await canal.consume(queue, (mensaje) => {
    if (mensaje) console.log(JSON.stringify({
      tipo: mensaje.fields.routingKey,
      contenido: mensaje.content.toString('base64'),
    }));
  }, { noAck: true });
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  console.log('LISTO');
`;

function responsables(tipo: string, datos?: unknown): string {
  const servicios = publicadores.get(tipo) ?? [];
  const servicio = (datos as { servicio?: string } | null)?.servicio;
  const responsables = servicio && servicios.includes(servicio) ? [servicio] : servicios;
  return responsables.map((s) => `${s} (${dueños.get(s) ?? 'dueño sin identificar'})`).join(', ');
}

function escuchar(proyecto: keyof typeof PROYECTOS, recibir: (linea: string) => void) {
  const hijo = spawn(
    'docker',
    ['exec', '-i', `${proyecto}-viajes-1`, 'node', '--input-type=module', '-e', capturador],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );

  const salida = createInterface({ input: hijo.stdout });
  const fin = Promise.withResolvers<undefined>();
  const listo = Promise.withResolvers<undefined>();
  let fallo: string | undefined;
  let cerrado = false;
  salida.on('line', (linea) => {
    if (linea === 'LISTO') listo.resolve(undefined);
    else recibir(linea);
  });
  hijo.on('error', () => {
    fallo = `No se pudo ejecutar Docker para escuchar el broker de ${proyecto}.`;
    listo.reject(new Error(fallo));
  });
  hijo.on('close', (codigo) => {
    if (!cerrado) {
      fallo = `El capturador de ${proyecto} se detuvo (código ${codigo}). Verificá el stack y RabbitMQ.`;
      listo.reject(new Error(fallo));
    }
    fin.resolve(undefined);
  });
  hijo.stdin.on('error', () => undefined);

  return {
    listo: listo.promise,
    fallo: () => fallo,
    async cerrar() {
      cerrado = true;
      hijo.stdin.end();
      const finalizó = await Promise.race([
        fin.promise.then(() => true),
        esperar(2000, false, { ref: false }),
      ]);
      if (!finalizó) hijo.kill();
    },
  };
}

export async function setup(): Promise<() => Promise<void>> {
  const vistos = new Map<string, number>();
  const diferencias = new Set<string>();
  let ultimoMensaje = 0;
  const escuchas = (Object.keys(PROYECTOS) as (keyof typeof PROYECTOS)[]).map((proyecto) =>
    escuchar(proyecto, (linea) => {
      ultimoMensaje = Date.now();
      let tipo = 'desconocido';
      try {
        const trama = JSON.parse(linea) as { tipo: string; contenido: string };
        tipo = trama.tipo;
        const validar = validadores.get(tipo);
        if (!validar) {
          diferencias.add(
            `[${proyecto}] Routing key sin contrato en ${urlAsyncApi.pathname}: ${tipo}`,
          );
          return;
        }
        const sobre = JSON.parse(Buffer.from(trama.contenido, 'base64').toString('utf8')) as {
          region?: string;
          datos?: unknown;
        };
        const dueño = responsables(tipo, sobre?.datos);
        vistos.set(tipo, (vistos.get(tipo) ?? 0) + 1);
        if (!validar(sobre)) {
          for (const error of validar.errors ?? []) {
            diferencias.add(
              `[${proyecto}] ${tipo} · ${dueño} · ${error.instancePath || '/'} · ${error.keyword} ${error.message ?? ''}`,
            );
          }
        }
        if (sobre?.region !== PROYECTOS[proyecto]) {
          diferencias.add(`[${proyecto}] ${tipo} · ${dueño} · región del sobre incorrecta`);
        }
      } catch {
        const dueño = responsables(tipo);
        diferencias.add(
          `[${proyecto}] Mensaje ${tipo} no se pudo leer como JSON${dueño ? ` · ${dueño}` : ''}`,
        );
      }
    }),
  );

  const inicio = new AbortController();
  try {
    await Promise.race([
      Promise.all(escuchas.map((captura) => captura.listo)),
      esperar(10_000, undefined, { signal: inicio.signal, ref: false }).then(() => {
        throw new Error('No se pudo iniciar la captura regional. Ejecutá npm run infra:levantar.');
      }),
    ]);
  } catch (error) {
    await Promise.all(escuchas.map((captura) => captura.cerrar()));
    throw error;
  } finally {
    inicio.abort();
  }

  return async () => {
    const limite = Date.now() + 5000;
    while (Date.now() < limite) {
      await esperar(250);
      if (
        [...validadores.keys()].every((tipo) => vistos.has(tipo)) &&
        Date.now() - ultimoMensaje >= 750
      )
        break;
    }
    await Promise.all(escuchas.map((captura) => captura.cerrar()));
    for (const captura of escuchas) {
      const fallo = captura.fallo();
      if (fallo) diferencias.add(fallo);
    }
    for (const tipo of validadores.keys()) {
      if (!vistos.has(tipo)) diferencias.add(`Sin mensaje E2E de ${tipo} · ${responsables(tipo)}`);
    }
    if (diferencias.size) throw new Error(`Contratos de RabbitMQ:\n${[...diferencias].join('\n')}`);
    process.stdout.write(
      `Contratos de RabbitMQ: ${[...vistos].map(([tipo, total]) => `${tipo}=${total}`).join(', ')}\n`,
    );
  };
}
