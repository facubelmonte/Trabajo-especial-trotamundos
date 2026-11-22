import { crearValidador, type Pool } from '@trotamundos/comun';
import { firmarJwt, generarClaves, loggerDePrueba } from '@trotamundos/comun/pruebas';
import { describe, expect, it, vi } from 'vitest';
import { crearAdaptadorAerolinea } from '../src/adaptadores/aerolinea.ts';
import { crearAdaptadorHotel } from '../src/adaptadores/hotel.ts';
import { crearApp, crearNegocioIntegraciones, SERVICIO } from '../src/app.ts';
import type { ResultadoAplicarReprogramacion } from '../src/adaptadores/tipos.ts';

const { logger } = loggerDePrueba(SERVICIO);
const region = 'region-1';

describe.skipIf(process.env.AUDITORIA === undefined)('Auditoría de Integraciones', () => {
  it('envía una sola orden al proveedor si dos réplicas reciben la misma confirmación', async () => {
    const ahora = '2026-11-21T12:00:00.000Z';
    const opcion = { proveedor: 'aerolinea-andina', numeroReserva: 'TEST01', opcionId: 'opt-1' };
    let aplicadaEn: string | null = null;
    let lecturas = 0;
    const segundaLectura = Promise.withResolvers<undefined>();
    const primeraLlamada = Promise.withResolvers<undefined>();
    const respuestaProveedor = Promise.withResolvers<ResultadoAplicarReprogramacion>();

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT proveedor, numero_reserva, opcion_id')) {
          lecturas += 1;
          if (lecturas === 2) segundaLectura.resolve(undefined);
          return {
            rows: [
              {
                proveedor: opcion.proveedor,
                numero_reserva: opcion.numeroReserva,
                opcion_id: opcion.opcionId,
                vence_en: '2026-11-22T12:00:00.000Z',
                aplicada_en: aplicadaEn,
              },
            ],
          };
        }
        if (sql.includes('UPDATE opciones_reprogramacion_ofrecidas')) {
          aplicadaEn = ahora;
          return { rows: [] };
        }
        throw new Error(`Consulta no contemplada en la prueba: ${sql}`);
      }),
    } as unknown as Pool;
    const adaptador = crearAdaptadorAerolinea({
      nombre: opcion.proveedor,
      url: 'http://proveedor.invalid',
      claveApi: 'prueba',
      secretoWebhook: 'prueba',
    });
    const aplicar = vi.spyOn(adaptador, 'aplicarReprogramacion').mockImplementation(() => {
      primeraLlamada.resolve(undefined);
      return respuestaProveedor.promise;
    });
    const claves = await generarClaves();
    const crearReplica = () =>
      crearApp({
        region,
        puerto: 0,
        logger,
        manejarSenales: false,
        validador: crearValidador({
          servicio: SERVICIO,
          region,
          logger,
          claves: { [region]: { claves: claves.jwks } },
          registrar: () => undefined,
        }),
        negocio: crearNegocioIntegraciones({
          pool,
          region,
          logger,
          ahora: () => Date.parse(ahora),
          configProveedores: { proveedores: [], agencias: [], redes: [] },
          registro: {
            obtener: () => adaptador,
            listar: () => [adaptador],
            listarPorModo: () => [],
          },
          urlUsuarios: 'http://usuarios.invalid',
        }),
      });
    const replicas = [crearReplica(), crearReplica()] as const;
    const [primera, segunda] = replicas;
    const token = await firmarJwt(claves);
    const pedir = (puerto: number) =>
      fetch(`http://127.0.0.1:${puerto}/interna/reprogramaciones/aplicar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(opcion),
        signal: AbortSignal.timeout(3000),
      });

    try {
      const puertoPrimera = await primera.iniciar();
      const puertoSegunda = await segunda.iniciar();
      const primerPedido = pedir(puertoPrimera);
      await Promise.race([
        primeraLlamada.promise,
        primerPedido.then((r) => {
          throw new Error(
            `La primera solicitud finalizó antes de invocar al proveedor: ${r.status}`,
          );
        }),
      ]);
      const segundoPedido = pedir(puertoSegunda);
      try {
        await Promise.race([
          segundaLectura.promise,
          segundoPedido,
          new Promise<void>((resolve) => setTimeout(resolve, 200)),
        ]);
      } finally {
        respuestaProveedor.resolve({ opcionId: opcion.opcionId, aplicadaEn: ahora });
      }
      const respuestas = await Promise.all([primerPedido, segundoPedido]);
      expect(respuestas.map((respuesta) => respuesta.status)).toEqual([200, 200]);
      expect(aplicar).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(replicas.map((replica) => replica.detener()));
    }
  });

  it('descarta la conexión si falla el desbloqueo de una consulta periódica', async () => {
    const falla = new Error('No se pudo ejecutar pg_advisory_unlock');
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ adquirido: true }] };
      throw falla;
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      query: vi.fn(async () => ({ rows: [{ cursor: '2026-11-21T11:00:00.000Z' }] })),
    } as unknown as Pool;
    const adaptador = crearAdaptadorHotel({
      nombre: 'hotel-cordillera',
      url: 'http://proveedor.invalid',
      claveApi: 'prueba',
      intervaloConsultaMs: 120_000,
    });
    vi.spyOn(adaptador, 'consultarCambios').mockResolvedValue({ mensajes: [] });
    const { consultador } = crearNegocioIntegraciones({
      pool,
      region,
      logger,
      configProveedores: { proveedores: [], agencias: [], redes: [] },
      registro: {
        obtener: () => adaptador,
        listar: () => [adaptador],
        listarPorModo: () => [adaptador],
      },
      urlUsuarios: 'http://usuarios.invalid',
    });

    await consultador.consultarProveedor(adaptador.nombre).catch(() => undefined);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), [
      'integraciones:consulta:hotel-cordillera',
    ]);
    expect(release.mock.calls).toHaveLength(1);
    expect(release.mock.calls[0]?.[0]).toBeTruthy();
  });
});
