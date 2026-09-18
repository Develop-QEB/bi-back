import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { env } from './env.js';

/**
 * Autenticación contra la tabla `usuario` de QEB (misma que el sistema principal):
 * login por `correo_electronico` + `user_password` (bcrypt). SOLO SELECT — no
 * escribimos nada. bi-back firma su PROPIO JWT (HS256) para proteger sus endpoints.
 */

export interface UsuarioAuth {
  id: number;
  nombre: string;
  email: string;
  rol: string;
  area: string | null;
  puesto: string | null;
  foto_perfil: string | null;
}

interface Payload {
  userId: number;
  email: string;
  rol: string;
  nombre: string;
}

interface RowUsuario {
  id: number;
  nombre: string;
  correo_electronico: string;
  user_password: string | null;
  user_role: string | null;
  area: string | null;
  puesto: string | null;
  foto_perfil: string | null;
}

const EXPIRY = '12h';

export async function login(correo: string, password: string): Promise<{ token: string; user: UsuarioAuth }> {
  const email = String(correo || '').trim();
  if (!email || !password) throw new Error('Credenciales inválidas');

  const [u] = await query<RowUsuario>(
    `SELECT id, nombre, correo_electronico, user_password, user_role, area, puesto, foto_perfil
       FROM usuario
      WHERE correo_electronico = :email AND deleted_at IS NULL
      LIMIT 1`,
    { email }
  );
  if (!u || !u.user_password) throw new Error('Credenciales inválidas');

  const ok = await bcrypt.compare(password, u.user_password);
  if (!ok) throw new Error('Credenciales inválidas');

  const user: UsuarioAuth = {
    id: Number(u.id),
    nombre: u.nombre,
    email: u.correo_electronico,
    rol: u.user_role ?? 'Normal',
    area: u.area ?? null,
    puesto: u.puesto ?? null,
    foto_perfil: u.foto_perfil ?? null,
  };
  const payload: Payload = { userId: user.id, email: user.email, rol: user.rol, nombre: user.nombre };
  const token = jwt.sign(payload, env.jwtSecret, { expiresIn: EXPIRY });
  return { token, user };
}

/** Verifica un JWT emitido por bi-back. Lanza si es inválido/expirado. */
export function verificarToken(token: string): Payload {
  return jwt.verify(token, env.jwtSecret) as Payload;
}
