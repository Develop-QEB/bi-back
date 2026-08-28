import { query } from '../db.js';
import type { ConteoMonto, ConteoNombre, Dimension, Embudo, EtapaEmbudo } from '../types.js';

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
