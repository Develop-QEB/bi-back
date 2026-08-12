import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  db: {
    host: req('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 25060),
    user: req('DB_USER'),
    password: req('DB_PASSWORD'),
    database: req('DB_NAME', 'u658050396_QEB'),
    ssl: (process.env.DB_SSL ?? 'true') === 'true',
  },
  /** Base donde se crea/lee la tabla editable bi_presupuesto (nueva, aislada). */
  writeDb: process.env.BI_WRITE_DB ?? process.env.DB_NAME ?? 'u658050396_QEB',
  /** Si true, el back crea la tabla bi_presupuesto (única escritura). Default false = nada se crea. */
  allowCreate: (process.env.BI_ALLOW_CREATE ?? 'false') === 'true',
  /** 'TOTAL' = todos los Monto Total; 'VENTA' = solo U_dscTAsig='Venta'. */
  ventaDef: (process.env.VENTA_DEF ?? 'TOTAL').toUpperCase() as 'TOTAL' | 'VENTA',
} as const;
