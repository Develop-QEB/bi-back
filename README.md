# bi-back — Backend del BI de QEB (QEBI)

Servicio **standalone** (Express + TypeScript) que sirve el BI bajo la ruta **`/bi`**: resumen
de ventas, embudo, reportes, historial de acciones (con WebSocket en vivo), objetivos/metas y
presupuesto editable. Lee `V_APS_Globales` de la BD de QEB en **solo lectura** y escribe
objetivos/usuarios en una BD propia (Hostinger QEBI).

> Este código vivía embebido en `qeb-Back/src/bi` (montado con `withBi()` en el proceso del
> back grande). Se extrajo a su propio repo/proceso: `src/` es un **espejo** de ese módulo + un
> arranque standalone (`src/server.ts`). Al traer cambios nuevos del BI, se copia `qeb-Back/src/bi`
> sobre `bi-back/src` (sin tocar `server.ts`).

## Correr local
1. `cp .env.example .env` y llena los secretos (todas las variables llevan prefijo **`BI_`**).
2. `npm install`
3. `npm run dev`   (o `npm run build && npm start`)

El front (`bi-front`, repo aparte) apunta con `VITE_API_URL=https://<host>/bi`.

## Variables de entorno
Ver `.env.example`. Resumen:
- `PORT` — puerto del proceso (en el droplet: `3200`; nginx hace el proxy).
- `BI_CORS_ORIGIN` — orígenes del front (coma-separado); `localhost` y `*.qeb.mx` / `*.vercel.app` ya pasan solos.
- `BI_DB_*` — BD de ventas (**solo lectura**), de donde sale `V_APS_Globales`.
- `BI_WDB_*` — BD propia **escribible** (Hostinger): usuarios (`qebi_usuario`) + objetivos.
- `BI_JWT_SECRET` — mínimo 32 caracteres, **distinto** del `JWT_SECRET` de qeb-Back.
- `BI_VENTA_DEF` (`TOTAL`|`VENTA`), `BI_WRITE_DB`, `BI_ALLOW_CREATE`, `BI_SEED_KEY`.

## Despliegue
En el **droplet** (junto con release/stage/monitoreo/sync): `pm2` + `nginx` (`api-bi.qeb.mx`) +
auto-deploy por cron. Build: `npm ci && npm run build`; arranque: `npm start` (→ `dist/server.js`).

## Endpoints (todos bajo `/bi`)
`/bi/health` · `/bi/auth/login` · `/bi/resumen-ventas` · `/bi/asesores` · `/bi/clientes` ·
`/bi/anios` · `/bi/historial/*` · `/bi/reportes/*` · `/bi/objetivos` · `/bi/presupuesto` ·
WebSocket `/bi/ws/historial`.
