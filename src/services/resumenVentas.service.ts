import { query } from '../db.js';
import { env } from '../env.js';
import { mapaPresupuesto } from './presupuesto.service.js';
import { MESES_ES, type FiltrosResumen, type Kpi, type ResumenVentas } from '../types.js';

/**
 * Agregaciones del Resumen de Ventas desde la vista QEB `V_APS_Globales` (SOLO SELECT).
 * "aps" = venta real (Monto Total). Definición de venta configurable con VENTA_DEF.
 *
 * SUPUESTOS (ajustables contra el Power BI de IMU):
 *  - Mes/Catorcena: se toman de la columna `Mes` / `Periodo` (mes en que corre el periodo).
 *  - Semana: ISO−1 (convención IMU) sobre la fecha de venta `Fecha`.
 *  - Año anterior: sale de la misma vista filtrando `Año`=anio−1 (hoy solo hay 2026 → 0).
 */

const HIST_N_SEM = 6; // ventana de ventasPorSemana (pase a ventas), como Historico_Semanal

// --- semanaIMU = ISO−1 (misma convención que Historico_Semanal) ---
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t as any) - (y0 as any)) / 86400000 + 1) / 7);
}
const semanaIMU = (d: Date): number => isoWeek(d) - 1;

/** null/'' -> sin filtro. 'Trade' -> 'TRADE'. */
function baseSql(base: FiltrosResumen['base']): string | null {
  if (!base) return null;
  return base.toUpperCase();
}

/** Construye el WHERE común (año + filtros). Devuelve fragmento SQL y params. */
function where(anio: number, f: FiltrosResumen, opts: { conMes?: boolean } = {}) {
  const cond: string[] = ['`Año` = :anio'];
  const params: Record<string, unknown> = { anio };
  const b = baseSql(f.base);
  if (b) { cond.push('UPPER(`BASE`) = :base'); params.base = b; }
  if (f.cliente) { cond.push('`U_Cliente` = :cliente'); params.cliente = f.cliente; }
  if (opts.conMes && f.mes) { cond.push('`Mes` = :mes'); params.mes = f.mes; }
  if (env.ventaDef === 'VENTA') cond.push("`U_dscTAsig` = 'Venta'");
  return { sql: cond.join(' AND '), params };
}

const MONTO = 'SUM(`Monto Total`)';

async function ventasPorMes(anio: number, f: FiltrosResumen): Promise<Map<number, number>> {
  const w = where(anio, f);
  const rows = await query<{ mes: number; monto: string }>(
    `SELECT \`Mes\` mes, ${MONTO} monto FROM V_APS_Globales WHERE ${w.sql} GROUP BY \`Mes\``,
    w.params
  );
  return new Map(rows.filter((r) => r.mes != null).map((r) => [Number(r.mes), Number(r.monto)]));
}

async function ventasPorCatorcenaMap(anio: number, f: FiltrosResumen): Promise<Map<number, number>> {
  const w = where(anio, f);
  const rows = await query<{ catorcena: number; monto: string }>(
    `SELECT CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(\`Periodo\`,' ',-1),'-',1) AS UNSIGNED) catorcena,
            ${MONTO} monto
       FROM V_APS_Globales
      WHERE ${w.sql} AND \`Periodo\` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'
      GROUP BY catorcena`,
    w.params
  );
  return new Map(rows.filter((r) => r.catorcena).map((r) => [Number(r.catorcena), Number(r.monto)]));
}

/**
 * ventasPorSemana = Historico_Semanal (pase a ventas por semana, últimas 6 semanas
 * CON datos del año filtrado). Total de la semana = SUM(inversion) de las propuestas
 * que pasaron a ventas esa semana. Lee de QEB.
 *
 * Respeta los filtros: `anio` (YEAR de la fecha del pase), `base` (sap_database) y
 * `cliente` (razon_social). La ventana ya NO se ancla a "hoy": toma las últimas
 * HIST_N_SEM semanas con datos del propio año, para que cambiar de año funcione.
 */
async function ventasPorSemanaPase(f: FiltrosResumen) {
  const rows = await query<{ pid: number; fecha_hora: string; detalles: string; inversion: string; base: string | null; cliente: string | null }>(
    `SELECT h.ref_id pid, h.fecha_hora, h.detalles, pr.inversion, s.sap_database base, s.razon_social cliente
       FROM historial h
       JOIN propuesta pr ON pr.id = h.ref_id
       LEFT JOIN solicitud s ON s.id = pr.solicitud_id
      WHERE h.tipo='Propuesta' AND h.accion='Cambio de estado'
        AND h.detalles LIKE '%despues":"Pase a ventas"%'
        AND YEAR(h.fecha_hora) = :anio`,
    { anio: f.anio }
  );
  const baseF = f.base ? f.base.toUpperCase() : null;
  // dedup por propuesta: se queda con el pase MÁS RECIENTE (por timestamp) del año.
  const porProp = new Map<number, { semana: number; monto: number; ts: number }>();
  for (const r of rows) {
    let ok = false;
    try {
      ok = (JSON.parse(r.detalles).cambios || []).some(
        (c: any) => c.campo === 'Estado' && c.despues === 'Pase a ventas' && c.antes !== 'Pase a ventas'
      );
    } catch { /* detalles no-JSON */ }
    if (!ok) continue;
    if (baseF && !String(r.base ?? '').toUpperCase().includes(baseF)) continue;
    if (f.cliente && r.cliente !== f.cliente) continue;
    const fecha = new Date(r.fecha_hora);
    const ts = fecha.getTime();
    const prev = porProp.get(r.pid);
    if (!prev || ts > prev.ts) porProp.set(r.pid, { semana: semanaIMU(fecha), monto: Number(r.inversion || 0), ts });
  }
  const porSemana = new Map<number, number>();
  for (const p of porProp.values()) porSemana.set(p.semana, (porSemana.get(p.semana) ?? 0) + p.monto);
  // últimas HIST_N_SEM semanas CON datos del año (no depende de la fecha de hoy).
  return [...porSemana.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-HIST_N_SEM)
    .map(([semana, monto]) => ({ semana, anio: f.anio, etiqueta: `Semana ${semana}-${f.anio}`, monto }));
}

export async function getResumenVentas(f: FiltrosResumen): Promise<ResumenVentas> {
  const anio = f.anio;
  const anioPrev = anio - 1;

  const [mesAct, mesPrev, catAct, catPrev, ppto] = await Promise.all([
    ventasPorMes(anio, f),
    ventasPorMes(anioPrev, f),
    ventasPorCatorcenaMap(anio, f),
    ventasPorCatorcenaMap(anioPrev, f),
    mapaPresupuesto(anio, f.base),
  ]);

  // --- ventas mensuales (vs año anterior) ---
  const ventasMensuales = MESES_ES.map((etiqueta, i) => {
    const mes = i + 1;
    return { mes, etiqueta, aps: mesAct.get(mes) ?? 0, anioAnterior: mesPrev.get(mes) ?? 0 };
  });

  // --- ventas vs presupuesto ---
  const ventasVsPpto = MESES_ES.map((etiqueta, i) => {
    const mes = i + 1;
    return { mes, etiqueta, ppto: ppto.get(mes) ?? 0, aps: mesAct.get(mes) ?? 0 };
  });

  // --- ventas por catorcena (vs año anterior) ---
  const catorcenas = [...new Set([...catAct.keys(), ...catPrev.keys()])].sort((a, b) => a - b);
  const ventasPorCatorcena = catorcenas.map((catorcena) => ({
    catorcena,
    etiqueta: `CATORCENA ${String(catorcena).padStart(2, '0')}`,
    aps: catAct.get(catorcena) ?? 0,
    anioAnterior: catPrev.get(catorcena) ?? 0,
  }));

  // --- ventas por semana = Historico_Semanal (pase a ventas por semana) ---
  const ventasPorSemana = await ventasPorSemanaPase(f);

  // --- KPIs ---
  const totAps = [...mesAct.values()].reduce((a, b) => a + b, 0);
  const totPrev = [...mesPrev.values()].reduce((a, b) => a + b, 0);
  const totPpto = [...ppto.values()].reduce((a, b) => a + b, 0);
  const mesRef = f.mes ?? (mesAct.size ? Math.max(...mesAct.keys()) : new Date().getMonth() + 1);
  const apsMes = mesAct.get(mesRef) ?? 0;
  const pptoMes = ppto.get(mesRef) ?? 0;
  const apsMesPrev = mesPrev.get(mesRef) ?? 0;

  const kpis: Kpi[] = [
    { id: 'acum-vs-ppto', titulo: 'Ventas Acum vs PPTO', valor: totAps, objetivo: totPpto, tendencia: ventasMensuales.map((m) => m.aps) },
    { id: 'mensual-vs-ppto', titulo: 'Ventas Mensual vs PPTO', valor: apsMes, objetivo: pptoMes, tendencia: ventasPorSemana.map((s) => s.monto) },
    { id: 'acum-vs-anio-ant', titulo: 'Ventas Acum vs Año Ant', valor: totAps, objetivo: totPrev, tendencia: ventasMensuales.map((m) => m.anioAnterior) },
    { id: 'mensual-vs-anio-ant', titulo: 'Ventas Mensual vs Año Ant', valor: apsMes, objetivo: apsMesPrev, tendencia: ventasMensuales.map((m) => m.anioAnterior) },
  ];

  const promedioVentaSemanal = ventasPorSemana.length
    ? ventasPorSemana.reduce((a, s) => a + s.monto, 0) / ventasPorSemana.length
    : 0;

  return {
    actualizadoEn: new Date().toISOString().slice(0, 10),
    promedioVentaSemanal,
    kpis,
    ventasVsPpto,
    ventasPorSemana,
    ventasPorCatorcena,
    ventasMensuales,
  };
}

/** Lista de clientes distintos (para el filtro del front). */
export async function getClientes(): Promise<string[]> {
  const rows = await query<{ c: string }>(
    "SELECT DISTINCT `U_Cliente` c FROM V_APS_Globales WHERE `U_Cliente` IS NOT NULL AND `U_Cliente` <> '' AND `U_Cliente` <> '0' ORDER BY `U_Cliente`"
  );
  return rows.map((r) => r.c);
}

/** Años con datos (para el filtro). */
export async function getAnios(): Promise<number[]> {
  const rows = await query<{ a: number }>('SELECT DISTINCT `Año` a FROM V_APS_Globales WHERE `Año` IS NOT NULL ORDER BY `Año` DESC');
  return rows.map((r) => Number(r.a));
}
