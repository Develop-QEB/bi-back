/**
 * Contrato de datos del BI. DEBE coincidir con bi-front/src/types/bi.ts.
 * Si cambias algo aquí, refléjalo en el front (o viceversa).
 */
export type BaseDatos = 'CIMU' | 'Trade' | 'SAP';

export interface FiltrosResumen {
  base: BaseDatos | null;
  /** Nombre del asesor comercial (columna `U_Asesor`); null = todos */
  asesor: string | null;
  anio: number;
  mes: number | null;
}

export interface VentaVsPpto {
  mes: number;
  etiqueta: string;
  ppto: number;
  aps: number;
}

export interface VentaSemana {
  semana: number;
  anio: number;
  etiqueta: string;
  monto: number;
}

export interface VentaCatorcena {
  catorcena: number;
  etiqueta: string;
  aps: number;
  anioAnterior: number;
}

export interface VentaMensualComparada {
  mes: number;
  etiqueta: string;
  aps: number;
  anioAnterior: number;
}

export interface Kpi {
  id: string;
  titulo: string;
  valor: number;
  objetivo: number;
  tendencia: number[];
}

export interface ResumenVentas {
  actualizadoEn: string;
  promedioVentaSemanal: number;
  kpis: Kpi[];
  ventasVsPpto: VentaVsPpto[];
  ventasPorSemana: VentaSemana[];
  ventasPorCatorcena: VentaCatorcena[];
  ventasMensuales: VentaMensualComparada[];
}

/** Fila editable de presupuesto (la "meta" que pone IMU). */
export interface PresupuestoMes {
  anio: number;
  mes: number;
  /** null = aplica a todas las bases (meta global del mes) */
  base: BaseDatos | null;
  monto: number;
}

export const MESES_ES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
