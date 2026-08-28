import { query } from '../db.js';
import type { ConteoNombre, Embudo, EtapaEmbudo } from '../types.js';

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
