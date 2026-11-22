import type {
  ConfigAgenciaResuelta,
  ConfigProveedorResuelta,
  ConfigRedResuelta,
} from '../config-proveedores.ts';
import { crearAdaptadorAerolinea } from './aerolinea.ts';
import { crearAdaptadorAgencia, type AdaptadorAgencia } from './agencia.ts';
import { crearAdaptadorHotel } from './hotel.ts';
import { crearAdaptadorRedSocial, type AdaptadorRedSocial } from './redsocial.ts';
import { crearAdaptadorRentadora } from './rentadora.ts';
import { crearAdaptadorTren } from './tren.ts';
import type { AdaptadorProveedorViaje } from './tipos.ts';

export interface ContextoFabricaAdaptador {
  ahora?: () => number;
  fetch?: typeof fetch;
}

export type FabricaAdaptadorProveedor = (
  config: ConfigProveedorResuelta,
  contexto: ContextoFabricaAdaptador,
) => AdaptadorProveedorViaje;

/**
 * Fábricas de adaptadores por tipo de proveedor (ADR-003, QA-10).
 * Para sumar un nuevo medio de transporte (tren, autobús) se agrega su fábrica aquí y su entrada
 * en `config/proveedores.yaml` (ver `docs/agregar-proveedor.md`).
 */
export const FABRICAS_PROVEEDORES_DEFECTO: Record<string, FabricaAdaptadorProveedor> = {
  aerolinea: (cfg, ctx) => {
    if (!cfg.secretoWebhook) {
      throw new Error(`El adaptador de aerolínea "${cfg.nombre}" requiere secretoWebhook.`);
    }
    return crearAdaptadorAerolinea({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      secretoWebhook: cfg.secretoWebhook,
      ...(ctx.ahora ? { ahora: ctx.ahora } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
  },
  hotel: (cfg, ctx) =>
    crearAdaptadorHotel({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      intervaloConsultaMs: cfg.intervaloConsultaMs,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
  rentadora: (cfg, ctx) =>
    crearAdaptadorRentadora({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      intervaloConsultaMs: cfg.intervaloConsultaMs,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
  tren: (cfg, ctx) =>
    crearAdaptadorTren({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      intervaloConsultaMs: cfg.intervaloConsultaMs,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
};

export interface RegistroAdaptadoresProveedores {
  obtener(nombre: string): AdaptadorProveedorViaje | undefined;
  listar(): AdaptadorProveedorViaje[];
  listarPorModo(modo: 'aviso' | 'consulta'): AdaptadorProveedorViaje[];
}

export interface OpcionesRegistroProveedores {
  proveedores: ConfigProveedorResuelta[];
  fabricas?: Record<string, FabricaAdaptadorProveedor>;
  ahora?: () => number;
  fetch?: typeof fetch;
}

/** Construye los adaptadores de proveedores a partir de `config/proveedores.yaml`. */
export function crearRegistroAdaptadoresProveedores(
  opciones: OpcionesRegistroProveedores,
): RegistroAdaptadoresProveedores {
  const fabricas = {
    ...FABRICAS_PROVEEDORES_DEFECTO,
    ...(opciones.fabricas ?? {}),
  };
  const mapa = new Map<string, AdaptadorProveedorViaje>();
  const ctx: ContextoFabricaAdaptador = {
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  };

  for (const cfg of opciones.proveedores) {
    const fabrica = fabricas[cfg.tipo];
    if (!fabrica) {
      throw new Error(
        `Tipo de proveedor desconocido "${cfg.tipo}" para "${cfg.nombre}". Registrá su fábrica en adaptadores/registro.ts.`,
      );
    }
    const adaptador = fabrica(cfg, ctx);
    if (adaptador.modo !== cfg.modo) {
      throw new Error(
        `El proveedor "${cfg.nombre}" está configurado con modo "${cfg.modo}" pero su adaptador "${cfg.tipo}" usa modo "${adaptador.modo}".`,
      );
    }
    mapa.set(cfg.nombre, adaptador);
  }

  return {
    obtener: (nombre) => mapa.get(nombre),
    listar: () => [...mapa.values()],
    listarPorModo: (modo) => [...mapa.values()].filter((a) => a.modo === modo),
  };
}

export type FabricaAdaptadorAgencia = (
  config: ConfigAgenciaResuelta,
  contexto: ContextoFabricaAdaptador,
) => AdaptadorAgencia;

export const FABRICAS_AGENCIAS_DEFECTO: Record<string, FabricaAdaptadorAgencia> = {
  agencia: (cfg, ctx) =>
    crearAdaptadorAgencia({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      ...(ctx.ahora ? { ahora: ctx.ahora } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
};

export interface RegistroAdaptadoresAgencias {
  obtener(nombre: string): AdaptadorAgencia | undefined;
  listar(): AdaptadorAgencia[];
}

export function crearRegistroAdaptadoresAgencias(opciones: {
  agencias: ConfigAgenciaResuelta[];
  fabricas?: Record<string, FabricaAdaptadorAgencia>;
  ahora?: () => number;
  fetch?: typeof fetch;
}): RegistroAdaptadoresAgencias {
  const fabricas = { ...FABRICAS_AGENCIAS_DEFECTO, ...(opciones.fabricas ?? {}) };
  const mapa = new Map<string, AdaptadorAgencia>();
  const ctx: ContextoFabricaAdaptador = {
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  };

  for (const cfg of opciones.agencias) {
    const fabrica = fabricas[cfg.tipo];
    if (!fabrica) {
      throw new Error(`Tipo de agencia desconocido "${cfg.tipo}" para "${cfg.nombre}".`);
    }
    mapa.set(cfg.nombre, fabrica(cfg, ctx));
  }

  return {
    obtener: (nombre) => mapa.get(nombre),
    listar: () => [...mapa.values()],
  };
}

export type FabricaAdaptadorRed = (
  config: ConfigRedResuelta,
  contexto: ContextoFabricaAdaptador,
) => AdaptadorRedSocial;

export const FABRICAS_REDES_DEFECTO: Record<string, FabricaAdaptadorRed> = {
  redsocial: (cfg, ctx) =>
    crearAdaptadorRedSocial({
      nombre: cfg.nombre,
      url: cfg.url,
      token: cfg.token,
      ...(ctx.ahora ? { ahora: ctx.ahora } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
};

export interface RegistroAdaptadoresRedes {
  obtener(nombre: string): AdaptadorRedSocial | undefined;
  listar(): AdaptadorRedSocial[];
}

export function crearRegistroAdaptadoresRedes(opciones: {
  redes: ConfigRedResuelta[];
  fabricas?: Record<string, FabricaAdaptadorRed>;
  ahora?: () => number;
  fetch?: typeof fetch;
}): RegistroAdaptadoresRedes {
  const fabricas = { ...FABRICAS_REDES_DEFECTO, ...(opciones.fabricas ?? {}) };
  const mapa = new Map<string, AdaptadorRedSocial>();
  const ctx: ContextoFabricaAdaptador = {
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  };

  for (const cfg of opciones.redes) {
    const fabrica = fabricas[cfg.tipo];
    if (!fabrica) {
      throw new Error(`Tipo de red social desconocido "${cfg.tipo}" para "${cfg.nombre}".`);
    }
    mapa.set(cfg.nombre, fabrica(cfg, ctx));
  }

  return {
    obtener: (nombre) => mapa.get(nombre),
    listar: () => [...mapa.values()],
  };
}
