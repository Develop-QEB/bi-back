import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './env.js';
import { pool } from './db.js';
import { getAnios, getAsesores, getClientes, getResumenVentas } from './services/resumenVentas.service.js';
import { getPresupuesto, upsertPresupuesto } from './services/presupuesto.service.js';
import { getContexto, getEventos, getResumen } from './services/historial.service.js';
import { dimensionValida, getDistribucion, getEmbudo, getVentasPeriodo } from './services/reportes.service.js';
import { attachRealtime } from './realtime.js';
import type { BaseDatos, CategoriaAccion, FiltrosHistorial, FiltrosResumen } from './types.js';

const app = express();
// CORS: la lista de CORS_ORIGIN (para prod) + cualquier localhost/127.0.0.1 en dev,
// sin importar el puerto. Así abrir el front por localhost o por 127.0.0.1 funciona igual.
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl/Postman/same-origin
      if (env.corsOrigin.includes(origin)) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      // El front vive en Vercel (bi-qeb.vercel.app) y en el dominio qeb.mx.
      if (/^https:\/\/([a-z0-9-]+\.)*(vercel\.app|qeb\.mx)$/i.test(origin)) return cb(null, true);
      cb(new Error(`CORS: origen no permitido (${origin})`));
    },
  })
);
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
    cliente: typeof q.cliente === 'string' && q.cliente && q.cliente.toLowerCase() !== 'todos' ? q.cliente : null,
    anio: Number.isInteger(anio) ? anio : new Date().getFullYear(),
    mes: q.mes != null && q.mes !== '' ? Number(q.mes) : null,
  };
}

const CATEGORIAS: CategoriaAccion[] = ['eliminacion', 'autorizacion', 'rechazo', 'cambio_estado', 'asignacion', 'creacion', 'post_sap', 'otro'];
function parseFiltrosHistorial(req: Request): FiltrosHistorial {
  const q = req.query;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const cat = s(q.categoria);
  return {
    categoria: cat && (CATEGORIAS as string[]).includes(cat) ? (cat as CategoriaAccion) : null,
    campaniaId: q.campaniaId ? Number(q.campaniaId) : null,
    usuario: s(q.usuario),
    tipo: s(q.tipo),
    soloImpacto: q.soloImpacto === 'true' || q.soloImpacto === '1',
    desde: s(q.desde),
    hasta: s(q.hasta),
    limit: q.limit ? Number(q.limit) : 100,
  };
}

/** Envuelve un handler async y manda errores al middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get('/', (_req, res) =>
  res.json({
    service: 'bi-back',
    ok: true,
    endpoints: ['/health', '/resumen-ventas', '/asesores', '/clientes', '/anios', '/presupuesto', '/historial/eventos', '/historial/resumen', 'ws:/ws/historial'],
  })
);

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

app.get('/clientes', wrap(async (_req, res) => {
  res.json(await getClientes());
}));

app.get('/anios', wrap(async (_req, res) => {
  res.json(await getAnios());
}));

// --- Historial de acciones ---
app.get('/historial/eventos', wrap(async (req, res) => {
  res.json(await getEventos(parseFiltrosHistorial(req)));
}));

app.get('/historial/resumen', wrap(async (req, res) => {
  const f = parseFiltrosHistorial(req);
  res.json(await getResumen({ desde: f.desde, hasta: f.hasta }));
}));

app.get('/historial/contexto', wrap(async (req, res) => {
  const refId = Number(req.query.refId);
  if (!Number.isInteger(refId) || refId <= 0) return res.status(400).json({ error: 'refId inválido' });
  res.json(await getContexto(refId));
}));

// --- Reportes ---
app.get('/reportes/embudo', wrap(async (_req, res) => {
  res.json(await getEmbudo());
}));

app.get('/reportes/distribucion', wrap(async (req, res) => {
  const dim = String(req.query.dim ?? '');
  if (!dimensionValida(dim)) return res.status(400).json({ error: 'dim inválida' });
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json(await getDistribucion(dim, anio));
}));

app.get('/reportes/ventas-periodo', wrap(async (req, res) => {
  const per = String(req.query.periodo ?? 'mes');
  if (per !== 'mes' && per !== 'catorcena' && per !== 'semana') return res.status(400).json({ error: 'periodo inválido' });
  const anio = Number(req.query.anio) || new Date().getFullYear();
  const asesor = typeof req.query.asesor === 'string' && req.query.asesor.trim() ? req.query.asesor.trim() : null;
  res.json(await getVentasPeriodo(per, anio, asesor));
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

const server = http.createServer(app);
attachRealtime(server);
server.listen(env.port, () => {
  console.log(`🚀 bi-back en http://localhost:${env.port}  (CORS: ${env.corsOrigin.join(', ')})`);
});
