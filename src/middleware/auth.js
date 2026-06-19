'use strict';

const { supabaseAnon, createUserClient } = require('../config/supabase');
const { fail } = require('../utils/helpers');

/**
 * Middleware de autenticación.
 * 1. Extrae el Bearer token del header Authorization.
 * 2. Verifica el token con supabase.auth.getUser(token).
 * 3. Adjunta:
 *      req.user     -> usuario autenticado
 *      req.token    -> el JWT (lo usa /auth/logout)
 *      req.supabase -> cliente Supabase con RLS aplicada para este usuario
 *    Si algo falla -> 401.
 */
module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return fail(res, 401, 'Token de autorización ausente o mal formado');
    }

    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data || !data.user) {
      return fail(res, 401, 'Token inválido o expirado');
    }

    req.user = data.user;
    req.token = token;
    req.supabase = createUserClient(token);

    return next();
  } catch (err) {
    return fail(res, 401, 'No autorizado');
  }
};
