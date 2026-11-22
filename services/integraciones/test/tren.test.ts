// Pruebas del adaptador de trenes de prueba (QA-10, docs/agregar-proveedor.md, paso 5): traducción
// de confirmación, modificación con diff mínimo y cancelación; paginación; mensajes malformados sin
// datos personales; lote de 1.000 boletos (>= 99 % traducidos, QA-6) y registro desde el YAML.
import { crearEvento, validadorEventos } from '@trotamundos/comun';
import { describe, expect, it } from 'vitest';
import { crearRegistroAdaptadoresProveedores } from '../src/adaptadores/registro.ts';
import { ErrorModoNoSoportado, ErrorProveedorExterno } from '../src/adaptadores/tipos.ts';
import { crearAdaptadorTren } from '../src/adaptadores/tren.ts';
import { cargarConfigProveedores } from '../src/config-proveedores.ts';

const validador = validadorEventos();
const PROVEEDOR = 'trenes-del-sur';

function boleto(cambios: Record<string, unknown> = {}) {
  return {
    ticketCode: 'TS-48213',
    state: 'BOOKED',
    version: 1,
    updatedAt: '2026-11-20T10:00:00Z',
    departure: { station: 'Constitución', time: '2026-12-20T08:00:00-03:00' },
    arrival: { station: 'Mar del Plata', time: '2026-12-20T13:30:00-03:00' },
    train: { number: 'TS 301', coach: '4', seat: '12A' },
    passenger: { fullName: 'Ana Pérez', email: 'ana@correo.example', phone: '+54 11 5555-0000' },
    ...cambios,
  };
}

const adaptador = (fetchFalso?: typeof fetch) =>
  crearAdaptadorTren({
    nombre: PROVEEDOR,
    url: 'http://mock-trenes:4008/',
    claveApi: 'k-tren',
    intervaloConsultaMs: 120_000,
    ...(fetchFalso ? { fetch: fetchFalso } : {}),
  });

/** El evento traducido cumple specs/schemas/ReservaActualizada.json. */
function validarEvento(evento: unknown) {
  expect(() =>
    validador.validar(crearEvento('ReservaActualizada', evento, 'region-1')),
  ).not.toThrow();
}

describe('Adaptador de trenes de prueba (QA-10)', () => {
  it('primera vez manda el viaje completo; después solo el diff; la cancelación va sin cambios', () => {
    const tren = adaptador();
    const primera = tren.traducir(boleto());
    expect(primera.ok).toBe(true);
    if (!primera.ok) return;
    expect(primera.evento).toEqual({
      proveedor: PROVEEDOR,
      numeroReserva: 'TS-48213',
      estado: 'confirmada',
      cambios: {
        inicio: '2026-12-20T08:00:00-03:00',
        fin: '2026-12-20T13:30:00-03:00',
        origen: 'Constitución',
        destino: 'Mar del Plata',
      },
      origenCambio: 'proveedor',
    });
    validarEvento(primera.evento);

    const cambio = tren.traducir(
      boleto({
        state: 'CHANGED',
        version: 2,
        arrival: { station: 'Mar del Plata', time: '2026-12-20T14:10:00-03:00' },
        train: { number: 'TS 301', coach: '4', seat: '14C' },
      }),
      primera.estadoActual,
    );
    expect(cambio.ok && cambio.evento.cambios).toEqual({
      fin: '2026-12-20T14:10:00-03:00',
      detalle: { asiento: '14C' },
    });
    expect(cambio.ok && cambio.claveVersion).toBe('2');
    if (cambio.ok) validarEvento(cambio.evento);

    const cancelacion = tren.traducir(
      boleto({ state: 'CANCELLED', version: 3 }),
      primera.estadoActual,
    );
    expect(cancelacion.ok && cancelacion.evento.estado).toBe('cancelada');
    expect(cancelacion.ok && cancelacion.evento.cambios).toEqual({});
    if (cancelacion.ok) validarEvento(cancelacion.evento);
  });

  it('un boleto que no se puede traducir queda sin datos del pasajero', () => {
    const resultado = adaptador().traducir(boleto({ state: 'ON_HOLD' }));
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toMatch(/state desconocido/);
    expect(resultado.cuerpoSinDatosPersonales).not.toMatch(/Ana|ana@correo|5555/);
    expect(resultado.cuerpoSinDatosPersonales).toContain('TS-48213');
  });

  it('pagina con nextPage, devuelve la marca más alta y traduce 503 a ErrorProveedorExterno', async () => {
    const pedidos: string[] = [];
    const paginas: Record<string, unknown> = {
      '1': { tickets: [boleto({ updatedAt: '2026-11-20T10:00:00Z' })], nextPage: 2 },
      '2': {
        tickets: [boleto({ ticketCode: 'TS-1', updatedAt: '2026-11-20T11:00:00Z' })],
        nextPage: null,
      },
    };
    const fetchFalso = (async (url: string | URL | Request, init?: RequestInit) => {
      pedidos.push(String(url));
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer k-tren');
      const pagina = new URL(String(url)).searchParams.get('page') ?? '';
      return Response.json(paginas[pagina]);
    }) as typeof fetch;

    const resultado = await adaptador(fetchFalso).consultarCambios('2026-11-20T00:00:00Z');
    expect(resultado.mensajes).toHaveLength(2);
    expect(resultado.marcaMasAlta).toBe('2026-11-20T11:00:00Z');
    expect(pedidos[0]).toBe(
      'http://mock-trenes:4008/v1/tickets?updatedSince=2026-11-20T00%3A00%3A00Z&page=1',
    );

    const caido = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(adaptador(caido).consultarCambios('2026-11-20T00:00:00Z')).rejects.toMatchObject({
      constructor: ErrorProveedorExterno,
      status: 503,
    });
  });

  it('no recibe webhooks y no ofrece reprogramación', async () => {
    const tren = adaptador();
    expect(() => tren.recibirAviso('{}', {})).toThrow(ErrorModoNoSoportado);
    expect(await tren.pedirOpcionesReprogramacion('TS-48213')).toEqual([]);
    await expect(tren.aplicarReprogramacion('TS-48213', 'x')).rejects.toThrow(ErrorModoNoSoportado);
  });

  it('traduce al menos el 99 % de un lote de 1.000 boletos (QA-6)', () => {
    const tren = adaptador();
    const estados = ['BOOKED', 'CHANGED', 'CANCELLED'];
    let traducidos = 0;
    for (let i = 0; i < 1000; i++) {
      // 1 de cada 200 llega roto (sin horario de salida), como un mensaje real con errores.
      const roto = i % 200 === 0;
      const resultado = tren.traducir(
        boleto({
          ticketCode: `TS-${i}`,
          state: estados[i % 3],
          version: 1 + (i % 5),
          ...(roto ? { departure: { station: 'Constitución' } } : {}),
        }),
      );
      if (resultado.ok) {
        validarEvento(resultado.evento);
        traducidos += 1;
      }
    }
    expect(traducidos / 1000).toBeGreaterThanOrEqual(0.99);
  });

  it('se registra desde config/proveedores.yaml como proveedor por consulta', () => {
    const cfg = cargarConfigProveedores({
      env: {
        SECRETO_WEBHOOK_AEROLINEA: 's-air',
        CLAVE_API_TRENES_DEL_SUR: 'k-tren',
        INTERVALO_CONSULTA_TRENES_SEG: '90',
      },
    });
    const registro = crearRegistroAdaptadoresProveedores({ proveedores: cfg.proveedores });
    const tren = registro.obtener(PROVEEDOR);
    expect(tren?.tipo).toBe('tren');
    expect(tren?.intervaloConsultaMs).toBe(90_000);
    expect(registro.listarPorModo('consulta').map((a) => a.nombre)).toContain(PROVEEDOR);
  });
});
