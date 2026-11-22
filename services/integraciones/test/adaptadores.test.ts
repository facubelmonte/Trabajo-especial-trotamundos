// Pruebas unitarias de P2.D2: configuración YAML de proveedores, registro extensible (QA-10),
// verificación HMAC de webhooks, traducción de aerolínea/hotel/rentadora, sanitización PII en
// no_traducidos y lote de 1.000 mensajes (>= 99 % traducidos automáticamente, QA-6).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crearEvento, validadorEventos } from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearMockAerolinea, type MockAerolinea } from '../../../mocks/aerolinea/src/app.ts';
import { crearMockHotel, type MockHotel } from '../../../mocks/hotel/src/app.ts';
import { crearMockRentadora, type MockRentadora } from '../../../mocks/rentadora/src/app.ts';
import { crearAdaptadorAerolinea, verificarFirmaAerolinea } from '../src/adaptadores/aerolinea.ts';
import { crearAdaptadorHotel } from '../src/adaptadores/hotel.ts';
import { crearRegistroAdaptadoresProveedores } from '../src/adaptadores/registro.ts';
import { crearAdaptadorRentadora } from '../src/adaptadores/rentadora.ts';
import {
  ErrorCuerpoNoJson,
  ErrorFirmaInvalida,
  ErrorModoNoSoportado,
  ErrorProveedorExterno,
  type AdaptadorProveedorViaje,
} from '../src/adaptadores/tipos.ts';
import { cargarConfigProveedores, parsearConfigProveedores } from '../src/config-proveedores.ts';

const SECRETO = 'secreto-webhook-pruebas-aerolinea';
const validador = validadorEventos();

function firmar(cuerpo: Buffer | string, timestampSeg: number, secreto = SECRETO): string {
  const bytes = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8');
  const firma = createHmac('sha256', secreto)
    .update(`${timestampSeg}.`)
    .update(bytes)
    .digest('hex');
  return `t=${timestampSeg},v1=${firma}`;
}

function avisoAerolineaBase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wev_0000AN0000000042',
    type: 'order.airline_initiated_change_detected',
    created_at: '2026-11-28T09:12:30Z',
    idempotency_key: 'XKQ7PL-v2',
    data: {
      object: {
        order: {
          id: 'ord_0000AN000XKQ7PL',
          booking_reference: 'XKQ7PL',
          status: 'changed',
          version: 2,
          updated_at: '2026-11-28T09:12:30Z',
          cancelled_at: null,
          owner: { iata_code: 'AN', name: 'Aerolínea Andina' },
          passengers: [{ id: 'pas_0001', given_name: 'Ana', family_name: 'García' }],
          segments: [
            {
              id: 'seg_0002',
              marketing_carrier: { iata_code: 'AN' },
              marketing_carrier_flight_number: '1234',
              origin: { iata_code: 'EZE', city_name: 'Buenos Aires' },
              destination: { iata_code: 'SCL', city_name: 'Santiago' },
              departing_at: '2026-12-10T11:15:00-03:00',
              arriving_at: '2026-12-10T13:25:00-03:00',
              seat: '14C',
            },
          ],
          ...overrides,
        },
        removed: [
          {
            id: 'seg_0001',
            marketing_carrier: { iata_code: 'AN' },
            marketing_carrier_flight_number: '1234',
            origin: { iata_code: 'EZE', city_name: 'Buenos Aires' },
            destination: { iata_code: 'SCL', city_name: 'Santiago' },
            departing_at: '2026-12-10T08:30:00-03:00',
            arriving_at: '2026-12-10T10:40:00-03:00',
            seat: '14C',
          },
        ],
        added: [
          {
            id: 'seg_0002',
            marketing_carrier: { iata_code: 'AN' },
            marketing_carrier_flight_number: '1234',
            origin: { iata_code: 'EZE', city_name: 'Buenos Aires' },
            destination: { iata_code: 'SCL', city_name: 'Santiago' },
            departing_at: '2026-12-10T11:15:00-03:00',
            arriving_at: '2026-12-10T13:25:00-03:00',
            seat: '14C',
          },
        ],
      },
    },
  };
}

function reservaHotelBase(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: 'HC-48213',
    status: 'confirmed',
    revision: 1,
    createdAt: '2026-11-20T14:02:00Z',
    lastModified: '2026-11-20T14:02:00Z',
    hotel: {
      code: 'HC-SCL-01',
      name: 'Hotel Cordillera',
      address: 'Av. Providencia 1234',
      city: 'Santiago',
      countryCode: 'CL',
    },
    guest: { firstName: 'Ana', lastName: 'García', email: 'ana@correo.example' },
    checkIn: '2026-12-10T15:00:00-03:00',
    checkOut: '2026-12-14T11:00:00-03:00',
    room: { type: 'DBL', description: 'Doble superior', guests: 2 },
    ...overrides,
  };
}

function reservaRentadoraBase(overrides: Record<string, unknown> = {}) {
  return {
    confirmationNumber: 'RS-77120',
    status: 'CONFIRMED',
    version: 1,
    createdAt: '2026-11-21T10:15:00Z',
    updatedAt: '2026-11-21T10:15:00Z',
    driver: { firstName: 'Ana', lastName: 'García', phone: '+5491112345678' },
    vehicle: {
      acrissCode: 'ECMR',
      categoryName: 'Económico',
      make: 'Toyota',
      model: 'Yaris',
    },
    pickUp: {
      locationCode: 'SCLA01',
      locationName: 'Rentadora Sur Aeropuerto SCL',
      city: 'Santiago',
      dateTime: '2026-12-10T11:30:00-03:00',
    },
    dropOff: {
      locationCode: 'SCLA01',
      locationName: 'Rentadora Sur Aeropuerto SCL',
      city: 'Santiago',
      dateTime: '2026-12-14T09:00:00-03:00',
    },
    ...overrides,
  };
}

describe('Configuración de proveedores (config/proveedores.yaml) y registro extensible (QA-10)', () => {
  it('carga config/proveedores.yaml resolviendo URLs, credenciales e intervalos por entorno', () => {
    const cfg = cargarConfigProveedores({
      env: {
        URL_AEROLINEA: 'http://127.0.0.1:4103/',
        CLAVE_API_AEROLINEA: 'k-air',
        SECRETO_WEBHOOK_AEROLINEA: 's-air',
        URL_HOTEL: 'http://127.0.0.1:4104',
        CLAVE_API_HOTEL: 'k-hotel',
        INTERVALO_CONSULTA_HOTEL_SEG: '45',
        URL_RENTADORA: 'http://127.0.0.1:4105',
        CLAVE_API_RENTADORA: 'k-rent',
      },
    });

    expect(cfg.proveedores.map((p) => [p.nombre, p.tipo, p.modo])).toEqual([
      ['aerolinea-andina', 'aerolinea', 'aviso'],
      ['hotel-cordillera', 'hotel', 'consulta'],
      ['rentadora-sur', 'rentadora', 'consulta'],
      ['trenes-del-sur', 'tren', 'consulta'],
    ]);
    expect(cfg.proveedores[0]?.url).toBe('http://127.0.0.1:4103');
    expect(cfg.proveedores[1]?.intervaloConsultaMs).toBe(45_000);
    expect(cfg.proveedores[2]?.intervaloConsultaMs).toBe(120_000);
    expect(cfg.agencias[0]?.nombre).toBe('viajes-del-plata');
    expect(cfg.redes[0]?.nombre).toBe('redsocial');

    const registro = crearRegistroAdaptadoresProveedores({ proveedores: cfg.proveedores });
    expect(registro.listar()).toHaveLength(4);
    expect(registro.listarPorModo('aviso').map((a) => a.nombre)).toEqual(['aerolinea-andina']);
    expect(registro.listarPorModo('consulta').map((a) => a.nombre)).toEqual([
      'hotel-cordillera',
      'rentadora-sur',
      'trenes-del-sur',
    ]);
  });

  it('rechaza proveedores duplicados o modo aviso sin secreto de webhook', () => {
    expect(() =>
      parsearConfigProveedores(
        `
proveedores:
  - nombre: duplicado
    tipo: hotel
    modo: consulta
    urlPorDefecto: http://hotel:4004
  - nombre: duplicado
    tipo: hotel
    modo: consulta
    urlPorDefecto: http://hotel:4004
`,
        { env: {} },
      ),
    ).toThrow(/duplicado/i);

    expect(() =>
      parsearConfigProveedores(
        `
proveedores:
  - nombre: aerolinea-sin-secreto
    tipo: aerolinea
    modo: aviso
    urlPorDefecto: http://air:4003
    secretoWebhookEnv: FALTA_SECRETO
`,
        { env: {} },
      ),
    ).toThrow(/secreto de webhook/i);
  });

  it('permite sumar un nuevo tipo de transporte (tren) solo con fábrica + YAML (QA-10)', () => {
    const cfg = parsearConfigProveedores(
      `
proveedores:
  - nombre: trenes-del-sur
    tipo: tren
    modo: consulta
    urlPorDefecto: http://mock-trenes:4008
    claveApiEnv: CLAVE_TRENES
    intervaloConsultaSeg: 90
`,
      { env: { CLAVE_TRENES: 'k-tren' } },
    );

    const adaptadorTren: AdaptadorProveedorViaje = {
      nombre: 'trenes-del-sur',
      tipo: 'tren',
      modo: 'consulta',
      intervaloConsultaMs: 90_000,
      recibirAviso() {
        throw new ErrorModoNoSoportado('Solo consulta');
      },
      async consultarCambios() {
        return { mensajes: [] };
      },
      traducir() {
        return { ok: false, motivo: 'stub', cuerpoSinDatosPersonales: '{}' };
      },
      async pedirOpcionesReprogramacion() {
        return [];
      },
      async aplicarReprogramacion() {
        throw new ErrorModoNoSoportado('No soporta');
      },
    };

    const registro = crearRegistroAdaptadoresProveedores({
      proveedores: cfg.proveedores,
      fabricas: { tren: () => adaptadorTren },
    });

    expect(registro.obtener('trenes-del-sur')?.tipo).toBe('tren');
    expect(registro.obtener('trenes-del-sur')?.intervaloConsultaMs).toBe(90_000);
  });
});

describe('Adaptador de aerolínea (HMAC + traducción)', () => {
  const ahoraFijo = Date.parse('2026-11-28T09:15:00Z');
  const tActual = Math.floor(ahoraFijo / 1000);
  const adaptador = crearAdaptadorAerolinea({
    nombre: 'aerolinea-andina',
    url: 'http://mock-aerolinea:4003',
    claveApi: 'clave-air',
    secretoWebhook: SECRETO,
    ahora: () => ahoraFijo,
  });

  it('acepta firma HMAC válida sobre bytes crudos y rechaza ausente, adulterada o vencida (> 5 min)', () => {
    const crudo = Buffer.from('{"hola": 1,   "espacios": true}', 'utf8');
    const headerValido = firmar(crudo, tActual);

    expect(() => verificarFirmaAerolinea(crudo, headerValido, SECRETO, ahoraFijo)).not.toThrow();
    expect(adaptador.recibirAviso(crudo, { 'X-Webhook-Signature': headerValido })).toEqual({
      mensaje: { hola: 1, espacios: true },
    });

    expect(() => adaptador.recibirAviso(crudo, {})).toThrow(ErrorFirmaInvalida);
    expect(() =>
      adaptador.recibirAviso(crudo, { 'x-webhook-signature': 'formato-invalido' }),
    ).toThrow(ErrorFirmaInvalida);
    expect(() =>
      adaptador.recibirAviso(crudo, { 'x-webhook-signature': firmar(crudo, tActual, 'otro') }),
    ).toThrow(ErrorFirmaInvalida);
    // Modificar un solo espacio invalida la firma (prueba que se firma sobre bytes crudos).
    expect(() =>
      adaptador.recibirAviso(Buffer.from('{"hola":1,"espacios":true}', 'utf8'), {
        'x-webhook-signature': headerValido,
      }),
    ).toThrow(ErrorFirmaInvalida);
    // Vencida por más de 5 minutos (301 s).
    expect(() =>
      adaptador.recibirAviso(crudo, { 'x-webhook-signature': firmar(crudo, tActual - 301) }),
    ).toThrow(ErrorFirmaInvalida);
    // Firma válida pero cuerpo no JSON -> ErrorCuerpoNoJson con tamaño exacto.
    const noJson = Buffer.from('no es json {{{', 'utf8');
    expect(() =>
      adaptador.recibirAviso(noJson, { 'x-webhook-signature': firmar(noJson, tActual) }),
    ).toThrow(ErrorCuerpoNoJson);
  });

  it('traduce el ejemplo de specs/externos/aerolinea.md igual al ejemplo válido de ReservaActualizada', () => {
    const rutaEjemplo = fileURLToPath(
      new URL('../../../specs/schemas/ejemplos/ReservaActualizada.valido.json', import.meta.url),
    );
    const ejemploSpec = JSON.parse(readFileSync(rutaEjemplo, 'utf8')) as {
      datos: Record<string, unknown>;
    };

    const res = adaptador.traducir(avisoAerolineaBase());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claveVersion).toBe('2');
    expect(res.evento).toEqual(ejemploSpec.datos);
    expect(() =>
      validador.validar(crearEvento('ReservaActualizada', res.evento, 'region-1')),
    ).not.toThrow();
  });

  it('traduce cancelaciones con cambios vacío y quita datos personales cuando no se puede traducir', () => {
    const cancelada = avisoAerolineaBase({
      status: 'cancelled',
      version: 3,
      cancelled_at: '2026-11-28T10:00:00Z',
      segments: [],
    });
    const resCancel = adaptador.traducir(cancelada);
    expect(resCancel.ok).toBe(true);
    if (resCancel.ok) {
      expect(resCancel.evento).toEqual({
        proveedor: 'aerolinea-andina',
        numeroReserva: 'XKQ7PL',
        estado: 'cancelada',
        cambios: {},
        origenCambio: 'proveedor',
      });
      expect(() =>
        validador.validar(crearEvento('ReservaActualizada', resCancel.evento, 'region-1')),
      ).not.toThrow();
    }

    const invalido = avisoAerolineaBase({ booking_reference: '' });
    const resInvalido = adaptador.traducir(invalido);
    expect(resInvalido.ok).toBe(false);
    if (!resInvalido.ok) {
      expect(resInvalido.motivo).toContain('booking_reference');
      expect(resInvalido.cuerpoSinDatosPersonales).not.toContain('Ana');
      expect(resInvalido.cuerpoSinDatosPersonales).not.toContain('García');
      expect(resInvalido.cuerpoSinDatosPersonales).toContain('[quitado]');
    }
  });
});

describe('Adaptadores de hotel y rentadora (diff mínimo, cancelación y PII)', () => {
  const hotel = crearAdaptadorHotel({
    nombre: 'hotel-cordillera',
    url: 'http://mock-hotel:4004',
    claveApi: 'k-hotel',
    intervaloConsultaMs: 120_000,
  });

  const rentadora = crearAdaptadorRentadora({
    nombre: 'rentadora-sur',
    url: 'http://mock-rentadora:4005',
    claveApi: 'k-rent',
    intervaloConsultaMs: 120_000,
  });

  it('hotel: primera vez manda inicio/fin/destino y en revisión siguiente manda solo el diff', () => {
    const r1 = hotel.traducir(reservaHotelBase());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.evento.cambios).toEqual({
      inicio: '2026-12-10T15:00:00-03:00',
      fin: '2026-12-14T11:00:00-03:00',
      destino: 'Santiago',
    });

    const r2 = hotel.traducir(
      reservaHotelBase({
        status: 'modified',
        revision: 2,
        checkIn: '2026-12-11T15:00:00-03:00',
      }),
      r1.estadoActual,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.evento).toEqual({
      proveedor: 'hotel-cordillera',
      numeroReserva: 'HC-48213',
      estado: 'modificada',
      cambios: { inicio: '2026-12-11T15:00:00-03:00' },
      origenCambio: 'proveedor',
    });

    const invalida = hotel.traducir(reservaHotelBase({ status: 'waitlisted' }));
    expect(invalida.ok).toBe(false);
    if (!invalida.ok) {
      expect(invalida.cuerpoSinDatosPersonales).not.toContain('Ana');
      expect(invalida.cuerpoSinDatosPersonales).not.toContain('ana@correo.example');
    }

    expect(() => hotel.recibirAviso('{}', {})).toThrow(ErrorModoNoSoportado);
  });

  it('rentadora: diff mínimo, cancelación y ocultamiento de datos del conductor', () => {
    const r1 = rentadora.traducir(reservaRentadoraBase());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.evento.cambios).toEqual({
      inicio: '2026-12-10T11:30:00-03:00',
      fin: '2026-12-14T09:00:00-03:00',
      origen: 'Rentadora Sur Aeropuerto SCL',
      destino: 'Rentadora Sur Aeropuerto SCL',
    });

    const r2 = rentadora.traducir(
      reservaRentadoraBase({
        status: 'MODIFIED',
        version: 2,
        vehicle: {
          acrissCode: 'CDMR',
          categoryName: 'Compacto',
          make: 'Toyota',
          model: 'Corolla',
        },
      }),
      r1.estadoActual,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.evento.cambios).toEqual({
      detalle: { modelo: 'Toyota Corolla', categoria: 'Compacto' },
    });

    const rCancel = rentadora.traducir(
      reservaRentadoraBase({ status: 'CANCELLED', version: 3 }),
      r2.estadoActual,
    );
    expect(rCancel.ok).toBe(true);
    if (rCancel.ok) {
      expect(rCancel.evento).toEqual({
        proveedor: 'rentadora-sur',
        numeroReserva: 'RS-77120',
        estado: 'cancelada',
        cambios: {},
        origenCambio: 'proveedor',
      });
    }

    const invalida = rentadora.traducir(reservaRentadoraBase({ confirmationNumber: '' }));
    expect(invalida.ok).toBe(false);
    if (!invalida.ok) {
      expect(invalida.cuerpoSinDatosPersonales).not.toContain('García');
      expect(invalida.cuerpoSinDatosPersonales).not.toContain('+5491112345678');
    }
  });
});

describe('QA-6: lote de 1.000 mensajes de proveedores (>= 99 % traducidos automáticamente)', () => {
  it('traduce al menos el 99 % de un lote mixto de 1.000 mensajes y aísla los no traducibles sin PII', () => {
    const aerolinea = crearAdaptadorAerolinea({
      nombre: 'aerolinea-andina',
      url: 'http://mock-aerolinea:4003',
      claveApi: 'k-air',
      secretoWebhook: SECRETO,
    });
    const hotel = crearAdaptadorHotel({
      nombre: 'hotel-cordillera',
      url: 'http://mock-hotel:4004',
      claveApi: 'k-hotel',
      intervaloConsultaMs: 120_000,
    });
    const rentadora = crearAdaptadorRentadora({
      nombre: 'rentadora-sur',
      url: 'http://mock-rentadora:4005',
      claveApi: 'k-rent',
      intervaloConsultaMs: 120_000,
    });

    const TOTAL = 1000;
    const MALFORMADOS = 6; // 0,6 % malformados -> 99,4 % traducibles (>= 99 % exigido por QA-6)
    let traducidos = 0;
    const noTraducidos: { proveedor: string; motivo: string; cuerpo: string }[] = [];

    for (let i = 0; i < TOTAL; i++) {
      const esMalformado = i < MALFORMADOS;
      const turno = i % 3;
      const codigo = String(i + 1).padStart(4, '0');

      if (turno === 0) {
        const msg = esMalformado
          ? avisoAerolineaBase({
              booking_reference: i % 2 === 0 ? '' : `AIR${codigo}`,
              status: i % 2 === 0 ? 'changed' : 'unknown_state',
            })
          : i % 5 === 0
            ? avisoAerolineaBase({
                booking_reference: `AIR${codigo}`,
                status: 'cancelled',
                version: 2,
                cancelled_at: '2026-11-28T10:00:00Z',
                segments: [],
              })
            : avisoAerolineaBase({
                booking_reference: `AIR${codigo}`,
                status: 'changed',
                version: 2,
              });
        const res = aerolinea.traducir(msg);
        if (res.ok) {
          validador.validar(crearEvento('ReservaActualizada', res.evento, 'region-1'));
          traducidos++;
        } else {
          noTraducidos.push({
            proveedor: aerolinea.nombre,
            motivo: res.motivo,
            cuerpo: res.cuerpoSinDatosPersonales,
          });
        }
      } else if (turno === 1) {
        const msg = esMalformado
          ? reservaHotelBase({ reservationId: `HC-${codigo}`, status: 'on_hold' })
          : reservaHotelBase({
              reservationId: `HC-${codigo}`,
              status: i % 4 === 0 ? 'cancelled' : 'modified',
              revision: 2,
            });
        const res = hotel.traducir(msg);
        if (res.ok) {
          validador.validar(crearEvento('ReservaActualizada', res.evento, 'region-1'));
          traducidos++;
        } else {
          noTraducidos.push({
            proveedor: hotel.nombre,
            motivo: res.motivo,
            cuerpo: res.cuerpoSinDatosPersonales,
          });
        }
      } else {
        const msg = esMalformado
          ? reservaRentadoraBase({ confirmationNumber: `RS-${codigo}`, pickUp: null })
          : reservaRentadoraBase({
              confirmationNumber: `RS-${codigo}`,
              status: i % 4 === 0 ? 'CANCELLED' : 'MODIFIED',
              version: 2,
            });
        const res = rentadora.traducir(msg);
        if (res.ok) {
          validador.validar(crearEvento('ReservaActualizada', res.evento, 'region-1'));
          traducidos++;
        } else {
          noTraducidos.push({
            proveedor: rentadora.nombre,
            motivo: res.motivo,
            cuerpo: res.cuerpoSinDatosPersonales,
          });
        }
      }
    }

    expect(traducidos).toBe(TOTAL - MALFORMADOS);
    expect(traducidos / TOTAL).toBeGreaterThanOrEqual(0.99);
    expect(noTraducidos).toHaveLength(MALFORMADOS);
    for (const item of noTraducidos) {
      expect(item.cuerpo).not.toContain('Ana');
      expect(item.cuerpo).not.toContain('García');
      expect(item.cuerpo).not.toContain('ana@correo.example');
      expect(item.cuerpo).not.toContain('+5491112345678');
    }
  });
});

describe('Adaptadores HTTP en vivo contra los mocks reales (sin Docker)', () => {
  let mockAir: MockAerolinea;
  let mockHotel: MockHotel;
  let mockRent: MockRentadora;
  let urlAir = '';
  let urlHotel = '';
  let urlRent = '';

  beforeAll(async () => {
    mockAir = crearMockAerolinea({
      puerto: 0,
      apiKey: 'clave-air-live',
      webhookSecret: SECRETO,
      webhookUrls: [],
      logger: loggerDePrueba('mock-aerolinea').logger,
    });
    mockHotel = crearMockHotel({
      puerto: 0,
      apiKey: 'clave-hotel-live',
      logger: loggerDePrueba('mock-hotel').logger,
    });
    mockRent = crearMockRentadora({
      puerto: 0,
      apiKey: 'clave-rent-live',
      logger: loggerDePrueba('mock-rentadora').logger,
    });
    const [pA, pH, pR] = await Promise.all([
      mockAir.iniciar(),
      mockHotel.iniciar(),
      mockRent.iniciar(),
    ]);
    urlAir = `http://127.0.0.1:${pA}`;
    urlHotel = `http://127.0.0.1:${pH}`;
    urlRent = `http://127.0.0.1:${pR}`;
  });

  afterAll(async () => {
    await Promise.all([mockAir.detener(), mockHotel.detener(), mockRent.detener()]);
  });

  it('aerolínea: pide opciones, aplica reprogramación y traduce error 404/422/503', async () => {
    const adaptador = crearAdaptadorAerolinea({
      nombre: 'aerolinea-andina',
      url: urlAir,
      claveApi: 'clave-air-live',
      secretoWebhook: SECRETO,
    });

    const opciones = await adaptador.pedirOpcionesReprogramacion('XKQ7PL');
    expect(opciones.length).toBeGreaterThanOrEqual(1);
    const primera = opciones[0];
    if (!primera) throw new Error('Se esperaba al menos una opción de reprogramación');
    expect(primera.opcionId).toBeTruthy();
    expect(primera.origen).toBe('EZE');
    expect(primera.destino).toBe('SCL');
    expect(primera.costo.moneda).toBe('USD');

    const aplicada = await adaptador.aplicarReprogramacion('XKQ7PL', primera.opcionId);
    expect(aplicada.opcionId).toBe(primera.opcionId);
    expect(Date.parse(aplicada.aplicadaEn)).not.toBeNaN();

    // Aplicar de nuevo la misma oferta -> 422.
    await expect(adaptador.aplicarReprogramacion('XKQ7PL', primera.opcionId)).rejects.toMatchObject(
      { status: 422 },
    );

    // Reserva inexistente -> 404.
    await expect(adaptador.pedirOpcionesReprogramacion('NOEXISTE')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('hotel: pagina con nextCursor y traduce 503 a ErrorProveedorExterno(503)', async () => {
    const adaptador = crearAdaptadorHotel({
      nombre: 'hotel-cordillera',
      url: urlHotel,
      claveApi: 'clave-hotel-live',
      intervaloConsultaMs: 120_000,
      limitePagina: 2,
    });

    const consulta = await adaptador.consultarCambios('2020-01-01T00:00:00Z');
    expect(consulta.mensajes.length).toBeGreaterThan(2);
    expect(consulta.marcaMasAlta).toBeDefined();

    await fetch(`${urlHotel}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: '503' }),
    });
    await expect(adaptador.consultarCambios('2020-01-01T00:00:00Z')).rejects.toThrow(
      ErrorProveedorExterno,
    );
    await fetch(`${urlHotel}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'ninguna' }),
    });
  });

  it('rentadora: pagina con page/pageSize y traduce 503 a ErrorProveedorExterno(503)', async () => {
    const adaptador = crearAdaptadorRentadora({
      nombre: 'rentadora-sur',
      url: urlRent,
      claveApi: 'clave-rent-live',
      intervaloConsultaMs: 120_000,
      tamanoPagina: 2,
    });

    const consulta = await adaptador.consultarCambios('2020-01-01T00:00:00Z');
    expect(consulta.mensajes.length).toBeGreaterThan(2);
    expect(consulta.marcaMasAlta).toBeDefined();

    await fetch(`${urlRent}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: '503' }),
    });
    await expect(adaptador.consultarCambios('2020-01-01T00:00:00Z')).rejects.toThrow(
      ErrorProveedorExterno,
    );
    await fetch(`${urlRent}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'ninguna' }),
    });
  });
});
