import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatos from 'ajv-formats';
import { parse } from 'yaml';
import { CONFIG_E2E } from './comun.ts';

type Json = string | number | boolean | null | Json[] | { [clave: string]: Json };
type Objeto = { [clave: string]: Json };
interface Esquema {
  $ref?: string;
  required?: string[];
  properties?: Record<string, Esquema>;
  items?: Esquema;
}
interface Contenido {
  schema?: Esquema;
  example?: Json;
  examples?: Record<string, { value: Json }>;
}
interface Parametro {
  $ref?: string;
  name: string;
  in: string;
  required?: boolean;
}
interface Operacion {
  operationId: string;
  parameters?: Parametro[];
  requestBody?: { required?: boolean; content: Record<string, Contenido> };
  responses: Record<string, { $ref?: string; content?: Record<string, Contenido> }>;
}
interface Contrato {
  paths: Record<string, Record<string, Operacion | Parametro[]>>;
  components: {
    schemas?: Record<string, Esquema>;
    parameters?: Record<string, Parametro>;
    responses?: Operacion['responses'];
  };
}
interface Pedido {
  ruta: string;
  metodo: string;
  headers: Record<string, string>;
  body?: string;
}
interface Respuesta {
  status: number;
  tipo: string;
  body: string;
}
interface Caso {
  ruta: string;
  metodo: string;
  operacion: Operacion;
  parametros: Parametro[];
}
interface OpcionesCaso {
  status: number;
  cuerpo?: Json;
  parametros?: Record<string, string>;
  headers?: Record<string, string>;
  parametrosInvalidos?: Record<string, string>;
  signo?: (cuerpo: string) => Record<string, string>;
  estadoWebhook?: string;
  estadoValido?: string;
}

const exec = promisify(execFile);
const urlContratos = new URL('../../specs/openapi/', import.meta.url);
const uri = (nombre: string) => `https://trotamundos.example/specs/openapi/${nombre}.yaml`;
const leer = (nombre: string): Contrato =>
  parse(readFileSync(new URL(`${nombre}.yaml`, urlContratos), 'utf8')) as Contrato;
const comun = leer('comun');

async function pedir(servicio: string, pedido: Pedido): Promise<Respuesta> {
  if (pedido.ruta.startsWith('/interna/')) {
    // El gateway bloquea /interna. Ejecutar HTTP dentro de la red de pruebas de la región.
    const codigo = `
      const { ruta, ...init } = JSON.parse(process.argv[1]);
      const respuesta = await fetch('http://${servicio}:3005' + ruta, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
      console.log(JSON.stringify({
        status: respuesta.status, tipo: respuesta.headers.get('content-type') ?? '',
        body: await respuesta.text(),
      }));
    `;
    const { stdout } = await exec(
      'docker',
      ['exec', 'r1-viajes-1', 'node', '-e', codigo, JSON.stringify(pedido)],
      { timeout: 25_000 },
    );
    return JSON.parse(stdout) as Respuesta;
  }
  const { ruta, ...init } = pedido;
  const respuesta = await fetch(`${CONFIG_E2E.urlEnrutador}/api/${servicio}${ruta}`, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: respuesta.status,
    tipo: respuesta.headers.get('content-type') ?? '',
    body: await respuesta.text(),
  };
}

export function prepararContrato(servicio: 'asistente' | 'integraciones', token: string) {
  const contrato = leer(servicio);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  formatos.default(ajv);
  // Los JSON Pointer de OpenAPI usan components/schemas, incluidos los comunes entre documentos.
  ajv.addSchema({ $id: uri('comun'), components: { schemas: comun.components.schemas } });
  ajv.addSchema({ $id: uri(servicio), components: { schemas: contrato.components.schemas } });
  const casos = new Map<string, Caso>();
  const vistos = new Set<string>();
  const diferencias: string[] = [];
  for (const [ruta, item] of Object.entries(contrato.paths)) {
    for (const [metodo, operacion] of Object.entries(item)) {
      if (Array.isArray(operacion) || !operacion.operationId) continue;
      const parametros = [
        ...((item.parameters as Parametro[] | undefined) ?? []),
        ...(operacion.parameters ?? []),
      ];
      casos.set(operacion.operationId, {
        ruta,
        metodo: metodo.toUpperCase(),
        operacion,
        parametros,
      });
    }
  }
  function resolver<T extends { $ref?: string }>(objeto: T, seccion: string): T {
    if (!objeto.$ref) return objeto;
    const [archivo, ref] = objeto.$ref.split('#');
    const nombre = ref?.split('/').at(-1) ?? '';
    const origen = archivo ? comun : contrato;
    const componentes = origen.components as Record<string, Record<string, T> | undefined>;
    const valor = componentes[seccion]?.[nombre];
    if (!valor) throw new Error(`Referencia sin resolver: ${objeto.$ref}`);
    return resolver(valor, seccion);
  }
  function* omitirCampos(
    esquema: Esquema | undefined,
    dato: Json,
    nivel = '',
  ): Generator<[string, Json]> {
    if (!esquema || dato === null || typeof dato !== 'object') return;
    const s = resolver(esquema, 'schemas');
    if (Array.isArray(dato)) {
      // Una variante por campo del elemento del array, no por cada aparición de ese elemento.
      if (dato[0] !== undefined) {
        for (const [campo, nuevo] of omitirCampos(s.items, dato[0], `${nivel}[0]`)) {
          yield [campo, [nuevo, ...dato.slice(1)]];
        }
      }
      return;
    }
    for (const campo of s.required ?? []) {
      if (!(campo in dato)) throw new Error(`El ejemplo válido no contiene ${nivel}/${campo}`);
      const copia = Object.fromEntries(Object.entries(dato).filter(([clave]) => clave !== campo));
      yield [`${nivel}/${campo}`, copia];
    }
    for (const [campo, hijo] of Object.entries(dato)) {
      for (const [ruta, nuevo] of omitirCampos(s.properties?.[campo], hijo, `${nivel}/${campo}`)) {
        yield [ruta, { ...dato, [campo]: nuevo }];
      }
    }
  }
  function ejemplo(id: string): Json | undefined {
    const contenido = casos.get(id)?.operacion.requestBody?.content['application/json'];
    return structuredClone(
      contenido?.example ?? Object.values(contenido?.examples ?? {})[0]?.value,
    );
  }
  async function probar(id: string, ops: OpcionesCaso): Promise<Json | undefined> {
    const encontrado = casos.get(id);
    if (!encontrado) throw new Error(`Operación sin contrato: ${servicio}/${id}`);
    const caso: Caso = encontrado;
    vistos.add(id);
    const cabeceras = { Authorization: `Bearer ${token}`, 'X-Region': 'region-1', ...ops.headers };

    async function validar(
      campo: string,
      opciones: {
        cuerpo?: Json;
        status: number;
        headerAusente?: string;
        parametroInvalido?: string;
        estado?: string;
      },
    ): Promise<Json | undefined> {
      const cab = new Headers(cabeceras);
      const cuerpo = opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo);
      if (cuerpo !== undefined || ops.signo) cab.set('content-type', 'application/json');
      for (const [k, v] of Object.entries(ops.signo?.(cuerpo ?? '') ?? {})) cab.set(k, v);
      if (opciones.headerAusente) cab.delete(opciones.headerAusente);
      const parametros = { ...ops.parametros };
      if (opciones.parametroInvalido)
        parametros[opciones.parametroInvalido] =
          ops.parametrosInvalidos?.[opciones.parametroInvalido] ?? '!';
      const ruta = caso.ruta.replace(/\{([^}]+)\}/g, (_, nombre: string) =>
        encodeURIComponent(parametros[nombre] ?? ''),
      );
      const contexto = `[${servicio} · dueño D] ${caso.metodo} ${caso.ruta} · ${campo}`;
      const respuesta = await pedir(servicio, {
        ruta,
        metodo: caso.metodo,
        headers: Object.fromEntries(cab),
        ...(cuerpo !== undefined ? { body: cuerpo } : {}),
      });
      if (respuesta.status !== opciones.status) {
        throw new Error(`${contexto}: HTTP ${respuesta.status}, esperado ${opciones.status}`);
      }
      const declarada = caso.operacion.responses[String(respuesta.status)];
      if (!declarada) throw new Error(`${contexto}: HTTP ${respuesta.status} sin contrato`);
      const esquemaRespuesta = resolver(declarada, 'responses');
      const tipo = respuesta.tipo.split(';')[0]?.trim() ?? '';
      const schema = esquemaRespuesta.content?.[tipo]?.schema;
      if (!schema) throw new Error(`${contexto}: Content-Type ${tipo} sin esquema`);
      const origen = declarada.$ref?.startsWith('./comun.yaml#') ? 'comun' : servicio;
      const validarRespuesta = ajv.compile({
        $id: `${uri(origen)}-${id}-${opciones.status}-${encodeURIComponent(campo)}`,
        ...schema,
        ...(schema.$ref?.startsWith('#') ? { $ref: uri(origen) + schema.$ref } : {}),
      });
      const valor = JSON.parse(respuesta.body) as Json;
      if (!validarRespuesta(valor)) {
        throw new Error(`${contexto}: ${ajv.errorsText(validarRespuesta.errors)}`);
      }
      if (opciones.estado && (valor as Objeto).estado !== opciones.estado) {
        throw new Error(`${contexto}: estado esperado ${opciones.estado}`);
      }
      return valor;
    }

    const cuerpo = ops.cuerpo ?? ejemplo(id);
    async function ejecutar(campo: string, opciones: Parameters<typeof validar>[1]) {
      try {
        return await validar(campo, opciones);
      } catch (error) {
        diferencias.push(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    const resultado = await ejecutar('ejemplo válido', {
      status: ops.status,
      ...(ops.estadoValido ? { estado: ops.estadoValido } : {}),
      ...(cuerpo !== undefined ? { cuerpo } : {}),
    });
    const schema = caso.operacion.requestBody?.content['application/json']?.schema;
    if (cuerpo !== undefined) {
      for (const [campo, inv] of omitirCampos(schema, cuerpo)) {
        await ejecutar(`falta ${campo}`, {
          cuerpo: inv,
          status: ops.estadoWebhook ? 200 : 400,
          ...(ops.estadoWebhook ? { estado: ops.estadoWebhook } : {}),
        });
      }
    }
    if (caso.operacion.requestBody?.required) {
      await ejecutar('falta el cuerpo', { status: 400 });
    }
    for (const parametro of caso.parametros.map((p) => resolver(p, 'parameters'))) {
      if (!parametro.required) continue;
      const datos = cuerpo !== undefined ? { cuerpo } : {};
      if (parametro.in === 'path') {
        await ejecutar(`parámetro inválido ${parametro.name}`, {
          ...datos,
          parametroInvalido: parametro.name,
          status: ops.estadoWebhook ? 404 : 400,
        });
      }
      if (parametro.in === 'header') {
        await ejecutar(`falta ${parametro.name}`, {
          ...datos,
          headerAusente: parametro.name,
          status: 401,
        });
      }
    }
    return resultado;
  }
  return {
    probar,
    ejemplo,
    verificar() {
      const pendientes = [...casos.keys()].filter((id) => !vistos.has(id));
      const problemas = [
        ...pendientes.map((id) => `[${servicio} · dueño D] Falta probar ${id}`),
        ...diferencias,
      ];
      if (problemas.length) throw new Error(problemas.join('\n'));
    },
  };
}
