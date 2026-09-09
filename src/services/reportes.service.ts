import { query } from '../db.js';
import { normalizaAsesor } from '../lib/asesores.js';
import type {
  CampaniaDetalle, Ciclo, ConteoMonto, ConteoNombre, ConteoPeriodo, Dimension,
  Embudo, EtapaEmbudo, FiltrosReporte, OpcionesReporte, Periodo,
} from '../types.js';

const toISO = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

const filtroVacio = (anio: number): FiltrosReporte => ({ anio, mes: null, plaza: null, formato: null, mueble: null, cliente: null, asesor: null });

// Limpia el nombre del mueble: quita "RENTA/BONIFICACIÓN DE ESPACIOS ".
const limpiaMueble = (v: string) => String(v).replace(/^(RENTA|BONIFICACI[OÓ]N) DE ESPACIOS\s*/i, '').trim() || String(v);

/**
 * Dado un nombre de asesor CANÓNICO (normalizado), regresa los valores crudos de
 * la columna indicada que normalizan a él. Permite filtrar por asesor aunque la
 * BD guarde muchas variantes (MAYÚS/acentos/sufijos/apellidos).
 */
async function variantesAsesor(canonico: string, sql: string): Promise<string[]> {
  const rows = await query<{ a: string | null }>(sql);
  return [...new Set(rows.map((r) => r.a).filter((a): a is string => !!a && normalizaAsesor(a) === canonico))];
}

// ---------- Filtro para V_APS_Globales (ventas cerradas) ----------
async function vapsWhere(f: FiltrosReporte): Promise<{ where: string; params: Record<string, unknown> }> {
  const cond: string[] = ['`Año` = :anio'];
  const p: Record<string, unknown> = { anio: f.anio };
  if (f.mes) { cond.push('`Mes` = :mes'); p.mes = f.mes; }
  if (f.plaza) { cond.push('`Nombre de Plaza` = :plaza'); p.plaza = f.plaza; }
  if (f.formato) { cond.push('`Tipo Digital` = :formato'); p.formato = f.formato; }
  if (f.mueble) { cond.push('`Dscription` LIKE :mueble'); p.mueble = `%${f.mueble}%`; }
  if (f.cliente) { cond.push('`U_Cliente` = :cliente'); p.cliente = f.cliente; }
  if (f.asesor) {
    const vars = await variantesAsesor(f.asesor, 'SELECT DISTINCT `U_Asesor` a FROM V_APS_Globales WHERE `U_Asesor` IS NOT NULL');
    if (!vars.length) { cond.push('1=0'); }
    else {
      const keys = vars.map((_, i) => `:av${i}`);
      vars.forEach((v, i) => { p[`av${i}`] = v; });
      cond.push(`\`U_Asesor\` IN (${keys.join(',')})`);
    }
  }
  return { where: cond.join(' AND '), params: p };
}

// ---------- Filtro para el pipeline (solicitud/propuesta/campaña) ----------
// Se aplica sobre la solicitud `s`. Año/mes por s.fecha; cliente=razon_social;
// asesor por variantes; plaza/formato/mueble vía solicitudCaras (idquote = quote).
async function pipelineCond(f: FiltrosReporte, quoteExpr: string): Promise<{ cond: string[]; params: Record<string, unknown> }> {
  const cond: string[] = [];
  const p: Record<string, unknown> = {};
  cond.push('YEAR(s.fecha) = :anio'); p.anio = f.anio;
  if (f.mes) { cond.push('MONTH(s.fecha) = :mes'); p.mes = f.mes; }
  if (f.cliente) { cond.push('s.razon_social = :cliente'); p.cliente = f.cliente; }
  if (f.asesor) {
    const vars = await variantesAsesor(f.asesor, "SELECT DISTINCT asesor a FROM solicitud WHERE asesor IS NOT NULL AND asesor <> ''");
    if (!vars.length) { cond.push('1=0'); }
    else {
      const keys = vars.map((_, i) => `:sa${i}`);
      vars.forEach((v, i) => { p[`sa${i}`] = v; });
      cond.push(`s.asesor IN (${keys.join(',')})`);
    }
  }
  const scCond: string[] = [];
  if (f.plaza) { scCond.push('sc.estados LIKE :plazaLike'); p.plazaLike = `%${f.plaza}%`; }
  if (f.formato) { scCond.push('sc.tipo LIKE :formatoLike'); p.formatoLike = `%${f.formato}%`; }
  if (f.mueble) { scCond.push('sc.formato LIKE :muebleLike'); p.muebleLike = `%${f.mueble}%`; }
  if (scCond.length) {
    cond.push(`EXISTS (SELECT 1 FROM solicitudCaras sc WHERE sc.idquote = ${quoteExpr} AND ${scCond.join(' AND ')})`);
  }
  return { cond, params: p };
}

/** Ciclo de venta: días promedio entre transiciones (Solicitud→Propuesta→Aprobación). */
export async function getCiclo(f: FiltrosReporte): Promise<Ciclo> {
  const { cond, params } = await pipelineCond(f, 'p.id');
  const [r] = await query<{ solProp: string | null; propAprob: string | null; total: number; aprobadas: number }>(
    `SELECT AVG(DATEDIFF(p.fecha, s.fecha)) solProp,
            AVG(DATEDIFF(ca.fecha_aprobacion, p.fecha)) propAprob,
            COUNT(*) total,
            SUM(ca.fecha_aprobacion IS NOT NULL) aprobadas
       FROM solicitud s
       JOIN propuesta p ON p.solicitud_id = s.id
       LEFT JOIN campania ca ON ca.cotizacion_id = p.id
      WHERE ${cond.join(' AND ')}`,
    params
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

/** Detalle de campañas recientes (filtrado). */
export async function getCampanias(limit: number, f: FiltrosReporte): Promise<CampaniaDetalle[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const { cond, params } = await pipelineCond(f, 'p.id');
  const rows = await query<{
    id: number; nombre: string; status: string | null; total_caras: string | null; inversion: string | null;
    fecha_inicio: Date | null; fecha_fin: Date | null; cliente: string | null; asesor: string | null;
  }>(
    `SELECT ca.id, ca.nombre, ca.status, ca.total_caras, p.inversion, ca.fecha_inicio, ca.fecha_fin,
            s.razon_social cliente, s.asesor
       FROM campania ca
       JOIN propuesta p ON p.id = ca.cotizacion_id
       JOIN solicitud s ON s.id = p.solicitud_id
      WHERE ${cond.join(' AND ')}
      ORDER BY ca.id DESC
      LIMIT ${n}`,
    params
  );
  return rows.map((r) => ({
    id: Number(r.id),
    nombre: r.nombre,
    status: r.status,
    totalCaras: Number(r.total_caras) || 0,
    monto: Number(r.inversion) || 0,
    fechaInicio: toISO(r.fecha_inicio),
    fechaFin: toISO(r.fecha_fin),
    cliente: r.cliente,
    asesor: normalizaAsesor(r.asesor) ?? r.asesor,
  }));
}

/** Columna de V_APS_Globales para cada dimensión. */
const COL_DIM: Record<Dimension, string> = {
  plaza: 'Nombre de Plaza',
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

/** Distribución de monto/caras por una dimensión, con filtros. Ranking desc. */
export async function getDistribucion(dim: Dimension, f: FiltrosReporte): Promise<ConteoMonto[]> {
  const col = COL_DIM[dim];
  const { where, params } = await vapsWhere(f);
  // El asesor trae variantes del mismo nombre → traemos más filas para fusionar sin perder cola.
  const limite = dim === 'asesor' ? 200 : 30;
  const rows = await query<{ v: string | null; monto: string; caras: string | null; n: number }>(
    `SELECT \`${col}\` v, SUM(\`Monto Total\`) monto, SUM(\`Caras\`) caras, COUNT(*) n
       FROM V_APS_Globales
      WHERE ${where} AND \`${col}\` IS NOT NULL
      GROUP BY \`${col}\`
      ORDER BY monto DESC
      LIMIT ${limite}`,
    params
  );
  const base = rows
    .filter((r) => r.v != null && String(r.v).trim() && Number(r.monto) > 0)
    .map((r) => ({
      nombre: dim === 'mueble' ? limpiaMueble(String(r.v)) : String(r.v).trim(),
      monto: Number(r.monto),
      caras: Number(r.caras) || 0,
      n: Number(r.n),
    }));

  if (dim !== 'asesor') return base;

  const merged = new Map<string, ConteoMonto>();
  for (const r of base) {
    const nombre = normalizaAsesor(r.nombre) ?? r.nombre;
    const ex = merged.get(nombre) ?? { nombre, monto: 0, caras: 0, n: 0 };
    ex.monto += r.monto; ex.caras += r.caras; ex.n += r.n;
    merged.set(nombre, ex);
  }
  return [...merged.values()].sort((a, b) => b.monto - a.monto).slice(0, 30);
}

async function conteoStatus(tabla: 'solicitud' | 'propuesta' | 'campania', f: FiltrosReporte): Promise<ConteoNombre[]> {
  // Todas las etapas se anclan a la solicitud `s` (mismos filtros para el embudo completo).
  const join =
    tabla === 'solicitud' ? 'FROM solicitud s'
    : tabla === 'propuesta' ? 'FROM propuesta t JOIN solicitud s ON s.id = t.solicitud_id'
    : 'FROM campania t JOIN propuesta p ON p.id = t.cotizacion_id JOIN solicitud s ON s.id = p.solicitud_id';
  const quoteExpr = tabla === 'solicitud' ? 's.id' : tabla === 'propuesta' ? 't.id' : 'p.id';
  const statusCol = tabla === 'solicitud' ? 's.status' : 't.status';
  const { cond, params } = await pipelineCond(f, quoteExpr);
  const rows = await query<{ status: string | null; n: number }>(
    `SELECT ${statusCol} status, COUNT(*) n ${join} WHERE ${cond.join(' AND ')} GROUP BY ${statusCol} ORDER BY n DESC`,
    params
  );
  return rows
    .filter((r) => r.status)
    .map((r) => ({ nombre: String(r.status), valor: Number(r.n), eventos: Number(r.n) }));
}

const suma = (c: ConteoNombre[]) => c.reduce((a, b) => a + b.valor, 0);
const de = (c: ConteoNombre[], ...nombres: string[]) =>
  c.filter((x) => nombres.includes(x.nombre)).reduce((a, b) => a + b.valor, 0);

/** Ventas reales por período (mes 1–12 / catorcena / semana ISO), con filtros. */
export async function getVentasPeriodo(periodo: Periodo, f: FiltrosReporte): Promise<ConteoPeriodo[]> {
  const { where, params } = await vapsWhere(f);
  const cond = [where];
  let expr: string;
  if (periodo === 'mes') {
    expr = '`Mes`';
  } else if (periodo === 'catorcena') {
    expr = "CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(`Periodo`,' ',-1),'-',1) AS UNSIGNED)";
    cond.push("`Periodo` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'");
  } else {
    expr = 'WEEK(`Fecha`, 3)';
    cond.push('`Fecha` IS NOT NULL');
  }
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
    params
  );
  return rows
    .filter((r) => r.periodo != null)
    .map((r) => ({ periodo: Number(r.periodo), monto: Number(r.monto) || 0, caras: Number(r.caras) || 0 }));
}

export async function getEmbudo(f: FiltrosReporte): Promise<Embudo> {
  const [sol, prop, camp] = await Promise.all([
    conteoStatus('solicitud', f),
    conteoStatus('propuesta', f),
    conteoStatus('campania', f),
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

/** Valores distintos (para los dropdowns de la barra de filtros). */
export async function getOpciones(anio: number): Promise<OpcionesReporte> {
  const distinct = async (col: string) => {
    const rows = await query<{ v: string | null }>(
      `SELECT DISTINCT \`${col}\` v FROM V_APS_Globales WHERE \`Año\` = :anio AND \`${col}\` IS NOT NULL`,
      { anio }
    );
    return rows.map((r) => String(r.v).trim()).filter(Boolean);
  };
  const [plaza, formato, muebleRaw, cliente, asesorRaw] = await Promise.all([
    distinct('Nombre de Plaza'), distinct('Tipo Digital'), distinct('Dscription'), distinct('U_Cliente'), distinct('U_Asesor'),
  ]);
  const uniqSort = (a: string[]) => [...new Set(a)].sort((x, y) => x.localeCompare(y));
  return {
    plaza: uniqSort(plaza),
    formato: uniqSort(formato),
    mueble: uniqSort(muebleRaw.map(limpiaMueble)),
    cliente: uniqSort(cliente),
    asesor: uniqSort(asesorRaw.map((a) => normalizaAsesor(a)).filter((a): a is string => !!a)),
  };
}

export { filtroVacio };
