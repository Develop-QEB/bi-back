import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './env.js';
import { pool } from './db.js';
import { getAnios, getAsesores, getResumenVentas } from './services/resumenVentas.service.js';
import { getPresupuesto, upsertPresupuesto } from './services/presupuesto.service.js';
import type { BaseDatos, FiltrosResumen } from './types.js';

const app = express();
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

const BASES = new Set<BaseDatos>(['CIMU', 'Trade', 'SAP']);
function parseBase(v: unknown): BaseDatos | null {
  if (typeof v !== 'string' || v === '' || v.toLowerCase() === 'todas') return null;
  const hit = [...BASES].find((b) => b.toLowerCase() === v.toLowerCase());
  return hit ?? null;
}
function parseFiltros(req: Request): FiltrosResumen {
  const q = req.query;
  const anio = Number(q.anio);
  return {
    base: parseBase(q.base),
    asesor: typeof q.asesor === 'string' && q.asesor && q.asesor.toLowerCase() !== 'todos' ? q.asesor : null,
    anio: Number.isInteger(anio) ? anio : new Date().getFullYear(),
    mes: q.mes != null && q.mes !== '' ? Number(q.mes) : null,
  };
}

/** Envuelve un handler async y manda errores al middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get('/health', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, ts: new Date().toISOString() });
}));

app.get('/resumen-ventas', wrap(async (req, res) => {
  res.json(await getResumenVentas(parseFiltros(req)));
}));

app.get('/asesores', wrap(async (_req, res) => {
  res.json(await getAsesores());
}));

app.get('/anios', wrap(async (_req, res) => {
  res.json(await getAnios());
}));

// --- Presupuesto (meta editable — el lapicito) ---
app.get('/presupuesto', wrap(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json(await getPresupuesto(anio, parseBase(req.query.base)));
}));

app.put('/presupuesto', wrap(async (req, res) => {
  const { anio, mes, base, monto } = req.body ?? {};
  const fila = await upsertPresupuesto(Number(anio), Number(mes), parseBase(base), Number(monto));
  res.json(fila);
}));

// 404 + manejo de errores
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : 'error';
  console.error('❌', msg);
  res.status(500).json({ error: msg });
});

app.listen(env.port, () => {
  console.log(`🚀 bi-back en http://localhost:${env.port}  (CORS: ${env.corsOrigin.join(', ')})`);
});
