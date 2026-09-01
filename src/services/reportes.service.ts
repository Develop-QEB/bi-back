import { query } from '../db.js';
import type { CampaniaDetalle, Ciclo, ConteoMonto, ConteoNombre, ConteoPeriodo, Dimension, Embudo, EtapaEmbudo, Periodo } from '../types.js';

const toISO = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** Ciclo de venta: días promedio entre transiciones (Solicitud→Propuesta→Aprobación). */
export async function getCiclo(): Promise<Ciclo> {
  const [r] = await query<{ solProp: string | null; propAprob: string | null; total: number; aprobadas: number }>(
    `SELECT AVG(DATEDIFF(p.fecha, s.fecha)) solProp,
            AVG(DATEDIFF(ca.fecha_aprobacion, p.fecha)) propAprob,
            COUNT(*) total,
            SUM(ca.fecha_aprobacion IS NOT NULL) aprobadas
       FROM solicitud s
       JOIN propuesta p ON p.solicitud_id = s.id
       LEFT JOIN campania ca ON ca.cotizacion_id = p.id`
  );
  const solProp = Math.max(0, Math.round(Number(r?.solProp) || 0));
  const propAprob = Math.max(0, Math.round((Number(r?.propAprob) || 0) * 10) / 10);
  const total = Number(r?.total) || 0;
  const aprobadas = Number(r?.aprobadas) || 0;
  return {
    etapas: [
      { de: 'Solicitud', a: 'Propuesta', dias: solProp },
      { de: 'Propuesta', a: 'Aprobación', dias: propAprob },
    ],
    cicloTotalDias: Math.round((solProp + propAprob) * 10) / 10,
    conversionGlobalPct: total ? Math.round((aprobadas / total) * 1000) / 10 : 0,
    total,
  };
}

/** Detalle de campañas recientes. */
export async function getCampanias(limit = 40): Promise<CampaniaDetalle[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const rows = await query<{
    id: number; nombre: string; status: string | null; total_caras: string | null;
    fecha_inicio: Date | null; fecha_fin: Date | null; cliente: string | null; asesor: string | null;
  }>(
    `SELECT ca.id, ca.nombre, ca.status, ca.total_caras, ca.fecha_inicio, ca.fecha_fin,
            s.razon_social cliente, s.asesor
       FROM campania ca
       LEFT JOIN propuesta p ON p.id = ca.cotizacion_id
       LEFT JOIN solicitud s ON s.id = p.solicitud_id
      ORDER BY ca.id DESC
      LIMIT ${n}`
  );
  return rows.map((r) => ({
    id: Number(r.id),
    nombre: r.nombre,
    status: r.status,
    totalCaras: Number(r.total_caras) || 0,
    fechaInicio: toISO(r.fecha_inicio),
    fechaFin: toISO(r.fecha_fin),
    cliente: r.cliente,
    asesor: r.asesor,
  }));
}

/** Columna de V_APS_Globales para cada dimensión. */
const COL_DIM: Record<Dimension, string> = {
  plaza: 'U_dscSitio',
  digital: 'Tipo Digital',
  asesor: 'U_Asesor',
  cliente: 'U_Cliente',
  mueble: 'Dscription',
  categoria: 'U_Categoria',
  marca: 'U_Marca',
  producto: 'U_Producto',
};

export function dimensionValida(d: string): d is Dimension {
  return d in COL_DIM;
}

/** Distribución de monto/caras por una dimensión, en un año. Ranking desc. */
export async function getDistribucion(dim: Dimension, anio: number): Promise<ConteoMonto[]> {
  const col = COL_DIM[dim];
  const rows = await query<{ v: string | null; monto: string; caras: string | null; n: number }>(
    `SELECT \`${col}\` v, SUM(\`Monto Total\`) monto, SUM(\`Caras\`) caras, COUNT(*) n
       FROM V_APS_Globales
      WHERE \`Año\` = :anio AND \`${col}\` IS NOT NULL
      GROUP BY \`${col}\`
      ORDER BY monto DESC
      LIMIT 30`,
    { anio }
  );
  return rows
    .filter((r) => r.v != null && String(r.v).trim() && Number(r.monto) > 0)
    .map((r) => ({
      nombre: dim === 'mueble' ? String(r.v).replace(/^RENTA DE ESPACIOS\s*/i, '').trim() || String(r.v) : String(r.v).trim(),
      monto: Number(r.monto),
      caras: Number(r.caras) || 0,
      n: Number(r.n),
    }));
}

/**
 * Reportes agregados (SOLO SELECT). Por ahora: embudo de conversión
 * Solicitud → Propuesta → Campaña, con conteo por estatus de cada etapa.
 */

async function conteoStatus(tabla: string): Promise<ConteoNombre[]> {
  const rows = await query<{ status: string | null; n: number }>(
    `SELECT status, COUNT(*) n FROM \`${tabla}\` GROUP BY status ORDER BY n DESC`
  );
  return rows
    .filter((r) => r.status)
    .map((r) => ({ nombre: String(r.status), valor: Number(r.n), eventos: Number(r.n) }));
}

const suma = (c: ConteoNombre[]) => c.reduce((a, b) => a + b.valor, 0);
const de = (c: ConteoNombre[], ...nombres: string[]) =>
  c.filter((x) => nombres.includes(x.nombre)).reduce((a, b) => a + b.valor, 0);

/** Ventas reales por período (mes 1–12 / catorcena / semana ISO), opcional por asesor. */
export async function getVentasPeriodo(periodo: Periodo, anio: number, asesor: string | null): Promise<ConteoPeriodo[]> {
  const cond: string[] = ['`Año` = :anio'];
  const p: Record<string, unknown> = { anio };
  if (asesor) {
    cond.push('UPPER(`U_Asesor`) = :asesor');
    p.asesor = asesor.toUpperCase();
  }
  let expr: string;
  if (periodo === 'mes') {
    expr = '`Mes`';
  } else if (periodo === 'catorcena') {
    expr = "CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(`Periodo`,' ',-1),'-',1) AS UNSIGNED)";
    cond.push("`Periodo` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'");
  } else {
    expr = 'WEEK(`Fecha`, 3)'; // ISO week
    cond.push('`Fecha` IS NOT NULL');
  }
  // Subquery: se agrupa sobre el valor YA calculado (agrupar por alias fallaba en semana).
  const rows = await query<{ periodo: number | null; monto: string; caras: string | null }>(
    `SELECT periodo, SUM(monto) monto, SUM(caras) caras
       FROM (
         SELECT ${expr} periodo, \`Monto Total\` monto, \`Caras\` caras
           FROM V_APS_Globales
          WHERE ${cond.join(' AND ')}
       ) t
      WHERE periodo IS NOT NULL
      GROUP BY periodo
      ORDER BY periodo`,
    p
  );
  return rows
    .filter((r) => r.periodo != null)
    .map((r) => ({ periodo: Number(r.periodo), monto: Number(r.monto) || 0, caras: Number(r.caras) || 0 }));
}

export async function getEmbudo(): Promise<Embudo> {
  const [sol, prop, camp] = await Promise.all([
    conteoStatus('solicitud'),
    conteoStatus('propuesta'),
    conteoStatus('campania'),
  ]);

  const totalSol = suma(sol);
  const base = totalSol || 1;
  const etapa = (nombre: string, valor: number): EtapaEmbudo => ({
    nombre,
    valor,
    pct: Math.round((valor / base) * 1000) / 10,
  });

  const etapas: EtapaEmbudo[] = [
    etapa('Solicitudes', totalSol),
    etapa('Atendidas', de(sol, 'Atendida', 'Aprobada')),
    etapa('Propuestas aprobadas', de(prop, 'Aprobada', 'Liberada', 'Pase a ventas')),
    etapa('Campañas activas', de(camp, 'Aprobada', 'Por iniciar', 'finalizada')),
    etapa('Finalizadas', de(camp, 'finalizada')),
  ];

  return {
    etapas,
    solicitud: sol,
    propuesta: prop,
    campania: camp,
    totales: { solicitudes: totalSol, propuestas: suma(prop), campanias: suma(camp) },
  };
}
