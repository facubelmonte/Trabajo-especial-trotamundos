import {
  ErrorModoNoSoportado,
  ErrorProveedorExterno,
  esCadenaNoVacia,
  esEnteroPositivo,
  esFechaIsoValida,
  esObjeto,
  fechaMasReciente,
  llamarProveedorHttp,
  serializarSinDatosPersonales,
  type AdaptadorProveedorViaje,
  type CambiosReserva,
  type EncabezadosAviso,
  type EstadoReservaProveedor,
  type EstadoReservaTraducido,
  type OpcionReprogramacion,
  type ResultadoAplicarReprogramacion,
  type ResultadoAvisoCrudo,
  type ResultadoConsultaCruda,
  type ResultadoTraduccion,
} from './tipos.ts';

export interface OpcionesAdaptadorTren {
  nombre: string;
  url: string;
  claveApi: string;
  intervaloConsultaMs: number;
  maxPaginas?: number;
  tiempoMaximoMs?: number;
  fetch?: typeof fetch;
}

const ESTADOS_TREN: Record<string, EstadoReservaTraducido> = {
  BOOKED: 'confirmada',
  CHANGED: 'modificada',
  CANCELLED: 'cancelada',
};

/**
 * Adaptador de trenes de prueba (QA-10, docs/agregar-proveedor.md). Proveedor ficticio "Trenes
 * del Sur" que trabaja en modo `consulta`: `GET /v1/tickets?updatedSince=...&page=N` devuelve
 * `{ tickets, nextPage }`. Cada boleto trae `ticketCode`, `state` (BOOKED, CHANGED o CANCELLED),
 * `departure` y `arrival` (`station` y `time`), `train` (`number`, `coach`, `seat`), `passenger`,
 * `version` y `updatedAt`. Los datos del pasajero nunca pasan a `ReservaActualizada`.
 */
export function crearAdaptadorTren(opciones: OpcionesAdaptadorTren): AdaptadorProveedorViaje {
  const {
    nombre,
    url,
    claveApi,
    intervaloConsultaMs,
    maxPaginas = 500,
    tiempoMaximoMs = 5000,
    fetch: hacerFetch = fetch,
  } = opciones;
  const baseUrl = url.replace(/\/+$/, '');

  function recibirAviso(_cuerpo: Buffer | string, _headers: EncabezadosAviso): ResultadoAvisoCrudo {
    throw new ErrorModoNoSoportado(`El proveedor ${nombre} trabaja por consulta, no por webhook.`);
  }

  async function consultarCambios(desde: string): Promise<ResultadoConsultaCruda> {
    const mensajes: unknown[] = [];
    let marcaMasAlta: string | undefined;
    let pagina = 1;

    for (let vuelta = 0; vuelta < maxPaginas; vuelta++) {
      const parametros = new URLSearchParams({ updatedSince: desde, page: String(pagina) });
      const respuesta = await llamarProveedorHttp(
        hacerFetch,
        `${baseUrl}/v1/tickets?${parametros.toString()}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${claveApi}`, Accept: 'application/json' },
        },
        tiempoMaximoMs,
        nombre,
      );
      if (respuesta.status === 503) {
        throw new ErrorProveedorExterno(503, 'proveedor-no-disponible', `${nombre} no disponible.`);
      }
      if (!respuesta.ok) {
        throw new ErrorProveedorExterno(
          502,
          'error-proveedor',
          `${nombre} respondió ${respuesta.status} al consultar boletos modificados.`,
        );
      }
      const cuerpo: unknown = await respuesta.json();
      if (!esObjeto(cuerpo) || !Array.isArray(cuerpo.tickets)) {
        throw new ErrorProveedorExterno(
          502,
          'error-proveedor',
          `${nombre} devolvió un cuerpo inesperado al consultar boletos.`,
        );
      }
      for (const boleto of cuerpo.tickets) {
        mensajes.push(boleto);
        if (esObjeto(boleto)) marcaMasAlta = fechaMasReciente(marcaMasAlta, boleto.updatedAt);
      }
      if (!esEnteroPositivo(cuerpo.nextPage)) break;
      pagina = cuerpo.nextPage;
    }

    return { mensajes, ...(marcaMasAlta ? { marcaMasAlta } : {}) };
  }

  function traducir(mensaje: unknown, estadoPrevio?: EstadoReservaProveedor): ResultadoTraduccion {
    const fallar = (motivo: string): ResultadoTraduccion => ({
      ok: false,
      motivo,
      cuerpoSinDatosPersonales: serializarSinDatosPersonales(mensaje),
    });

    if (!esObjeto(mensaje)) return fallar('El boleto de tren no es un objeto JSON.');
    if (!esCadenaNoVacia(mensaje.ticketCode)) return fallar('Falta ticketCode.');
    const estado = typeof mensaje.state === 'string' ? ESTADOS_TREN[mensaje.state] : undefined;
    if (!estado) return fallar(`state desconocido: ${String(mensaje.state)}.`);
    if (!esEnteroPositivo(mensaje.version)) return fallar('Falta version válida.');

    const salida = mensaje.departure;
    const llegada = mensaje.arrival;
    if (
      !esObjeto(salida) ||
      !esObjeto(llegada) ||
      !esCadenaNoVacia(salida.station) ||
      !esCadenaNoVacia(llegada.station) ||
      !esFechaIsoValida(salida.time) ||
      !esFechaIsoValida(llegada.time)
    ) {
      return fallar('Faltan estación u horario de salida o de llegada.');
    }
    const tren = mensaje.train;
    if (!esObjeto(tren) || !esCadenaNoVacia(tren.number)) return fallar('Falta train.number.');

    const numeroReserva = mensaje.ticketCode.trim();
    const claveVersion = String(mensaje.version);
    const marcaTemporal = esFechaIsoValida(mensaje.updatedAt) ? mensaje.updatedAt : undefined;
    const detalleActual: Record<string, unknown> = {
      tren: tren.number,
      ...(esCadenaNoVacia(tren.coach) ? { coche: tren.coach } : {}),
      ...(esCadenaNoVacia(tren.seat) ? { asiento: tren.seat } : {}),
    };
    const estadoActual: EstadoReservaProveedor = {
      estado,
      inicio: salida.time,
      fin: llegada.time,
      origen: salida.station.trim(),
      destino: llegada.station.trim(),
      detalle: detalleActual,
      versionCambio: claveVersion,
    };

    const cambios: CambiosReserva = {};
    if (estado !== 'cancelada') {
      if (!estadoPrevio) {
        // Primera vez que ve el boleto: manda los datos actuales del viaje.
        cambios.inicio = estadoActual.inicio;
        cambios.fin = estadoActual.fin;
        cambios.origen = estadoActual.origen;
        cambios.destino = estadoActual.destino;
      } else {
        if (estadoActual.inicio !== estadoPrevio.inicio) cambios.inicio = estadoActual.inicio;
        if (estadoActual.fin !== estadoPrevio.fin) cambios.fin = estadoActual.fin;
        if (estadoActual.origen !== estadoPrevio.origen) cambios.origen = estadoActual.origen;
        if (estadoActual.destino !== estadoPrevio.destino) cambios.destino = estadoActual.destino;
        const detalleCambios = Object.fromEntries(
          Object.entries(detalleActual).filter(([k, v]) => estadoPrevio.detalle[k] !== v),
        );
        if (Object.keys(detalleCambios).length > 0) cambios.detalle = detalleCambios;
        // El esquema pide al menos un campo cuando el estado es modificada.
        if (estado === 'modificada' && Object.keys(cambios).length === 0) {
          cambios.inicio = estadoActual.inicio;
          cambios.fin = estadoActual.fin;
        }
      }
    }

    return {
      ok: true,
      claveVersion,
      evento: { proveedor: nombre, numeroReserva, estado, cambios, origenCambio: 'proveedor' },
      estadoActual,
      ...(marcaTemporal ? { marcaTemporal } : {}),
    };
  }

  async function pedirOpcionesReprogramacion(
    _numeroReserva: string,
  ): Promise<OpcionReprogramacion[]> {
    return [];
  }

  async function aplicarReprogramacion(
    _numeroReserva: string,
    _opcionId: string,
  ): Promise<ResultadoAplicarReprogramacion> {
    throw new ErrorModoNoSoportado(`El proveedor ${nombre} no soporta reprogramación por API.`);
  }

  return {
    nombre,
    tipo: 'tren',
    modo: 'consulta',
    intervaloConsultaMs,
    recibirAviso,
    consultarCambios,
    traducir,
    pedirOpcionesReprogramacion,
    aplicarReprogramacion,
  };
}
