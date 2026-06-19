'use strict';

/**
 * Respuesta de éxito estandarizada: { success: true, data }
 */
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

/**
 * Respuesta de error estandarizada: { success: false, error }
 */
function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

/**
 * Mapea un error de Supabase (Auth/PostgREST) a un código HTTP (regla #3):
 *   error de auth -> 401, not found -> 404, conflict -> 409, resto -> 500.
 */
function httpFromSupabaseError(error) {
  if (!error) return 500;

  // --- Errores de Supabase Auth (GoTrue) ---
  const isAuthError =
    error.__isAuthError === true ||
    error.name === 'AuthApiError' ||
    error.name === 'AuthError' ||
    error.name === 'AuthSessionMissingError' ||
    error.name === 'AuthWeakPasswordError';

  if (isAuthError) {
    // Email ya registrado / recurso ya existe -> conflicto.
    if (
      error.code === 'user_already_exists' ||
      error.code === 'email_exists' ||
      error.status === 422
    ) {
      return 409;
    }
    return 401;
  }

  // --- Errores de PostgREST / Postgres ---
  const code = error.code;
  if (code === 'PGRST116') return 404; // .single() sin filas (no encontrado)
  if (code === '23505') return 409;    // unique_violation
  if (code === '23503') return 409;    // foreign_key_violation
  if (code === '23514') return 409;    // check_violation

  if (error.status === 404) return 404;
  if (error.status === 409) return 409;
  if (error.status === 401 || error.status === 403) return 401;

  return 500;
}

/**
 * Envuelve un controlador async para capturar excepciones y delegarlas
 * al manejador de errores central de Express (evita try/catch repetido).
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---- Conversión de claves entre snake_case (DB) y camelCase (API) ----
const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/**
 * Convierte SOLO las claves de primer nivel de una fila (o array de filas)
 * de snake_case a camelCase. Los VALORES se preservan tal cual
 * (importante para columnas JSONB como selected_products, que son datos del cliente).
 */
function rowToCamel(row) {
  if (Array.isArray(row)) return row.map(rowToCamel);
  if (row === null || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

/**
 * Convierte un valor de fecha a ISO 8601.
 * - number  -> milisegundos (Long de Android)  -> new Date(ms).toISOString()
 * - string de solo dígitos (>= 12) -> milisegundos
 * - string ISO / Date parseable -> normalizado a ISO
 * Devuelve null si no es parseable.
 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && /^\d{12,}$/.test(value)) {
    return new Date(Number(value)).toISOString();
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = {
  ok,
  fail,
  httpFromSupabaseError,
  asyncHandler,
  snakeToCamel,
  camelToSnake,
  rowToCamel,
  toIso
};
