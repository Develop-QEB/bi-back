import 'dotenv/config';
import http from 'node:http';
import { loadBiConfig, setBiConfig } from './config';

/**
 * Arranque STANDALONE del BI (QEBI).
 *
 * Este código vivía embebido en qeb-Back (src/bi), montado con `withBi()` en la ruta /bi.
 * Aquí no hay app anfitriona: servimos `crearBiApp()` directo (todo cuelga de /bi, igual que
 * en el monolito, para que el front no cambie de ruta — solo de host) y le colgamos el
 * WebSocket del historial en /bi/ws/historial.
 *
 * IMPORTANTE: `./app` y `./realtime` se cargan con require() DESPUÉS de setBiConfig(), porque
 * db.ts crea su pool leyendo getBiConfig() al importarse. Es el mismo orden que usa el
 * interruptor del monolito (require('./app') dentro de withBi, tras setBiConfig).
 */

const r = loadBiConfig();
if (!r.ok) {
  console.error(`[bi-back] No arranca — faltan variables de entorno: ${r.missing.join(', ')}`);
  process.exit(1);
}
setBiConfig(r.cfg);

const { crearBiApp, origenPermitido } = require('./app') as typeof import('./app');
const { attachRealtime } = require('./realtime') as typeof import('./realtime');

const app = crearBiApp();
const server = http.createServer(app);
attachRealtime(server, origenPermitido);

const port = Number(process.env.PORT ?? 3200);
server.listen(port, () => {
  const origenes = r.cfg.corsOrigin.join(', ') || 'localhost/*.qeb.mx/*.vercel.app';
  console.log(`🚀 bi-back standalone escuchando en :${port} → rutas bajo /bi  (CORS: ${origenes})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[bi-back] ${sig} — cerrando`);
    server.close(() => process.exit(0));
    // Si algo deja sockets colgados, salimos igual tras 5 s.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
