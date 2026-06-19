'use strict';

const crypto = require('crypto');
const { supabaseAnon, supabaseAdmin, createUserClient } = require('../config/supabase');
const { ok, fail, httpFromSupabaseError, asyncHandler } = require('../utils/helpers');

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Busca un usuario de Supabase Auth por email recorriendo la lista paginada.
 * supabase-js no expone "getUserByEmail", así que paginamos admin.listUsers.
 * Suficiente para bases de usuarios pequeñas/medianas (hasta 50k con perPage 1000).
 * Devuelve el usuario o null. Requiere service_role.
 */
async function findAuthUserByEmail(email) {
  const target = String(email).trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data && data.users) || [];
    const match = users.find((u) => (u.email || '').toLowerCase() === target);
    if (match) return match;
    if (users.length < perPage) break; // última página
  }
  return null;
}

// Da forma camelCase a la sesión devuelta por Supabase Auth.
function shapeSession(session) {
  if (!session) return null;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    expiresIn: session.expires_in,
    tokenType: session.token_type
  };
}

/**
 * Registra o actualiza el dispositivo del usuario en public.user_devices.
 * Hace check-then-insert/update para no depender de un constraint UNIQUE concreto.
 * Guarda un hash del refresh token (nunca el token en claro).
 */
async function upsertDevice(userClient, userId, { hardwareDeviceId, deviceName, refreshToken }) {
  if (!hardwareDeviceId) return;

  const nowIso = new Date().toISOString();
  const refreshTokenHash = refreshToken ? sha256(refreshToken) : null;

  const { data: existing } = await userClient
    .from('user_devices')
    .select('id')
    .eq('user_id', userId)
    .eq('hardware_device_id', hardwareDeviceId)
    .maybeSingle();

  if (existing) {
    await userClient
      .from('user_devices')
      .update({
        device_name: deviceName ?? null,
        refresh_token_hash: refreshTokenHash,
        is_active: true,
        last_login: nowIso
      })
      .eq('id', existing.id);
  } else {
    await userClient.from('user_devices').insert({
      user_id: userId,
      hardware_device_id: hardwareDeviceId,
      device_name: deviceName ?? null,
      refresh_token_hash: refreshTokenHash,
      is_active: true,
      last_login: nowIso
    });
  }
}

/**
 * Lógica común de los flujos de Google (OAuth web e idToken nativo): tras tener el
 * `user` y un cliente con su JWT, crea la fila de perfil si es la primera vez
 * (registro) o la completa si llegan datos, y registra/actualiza el dispositivo.
 * Devuelve { isNewUser, error }. No usa `res`: el caller mapea el error a HTTP
 * con httpFromSupabaseError para conservar los códigos (409/401/…).
 */
async function syncGoogleProfileAndDevice(
  userClient,
  user,
  { businessName, businessCategory, hardwareDeviceId, deviceName, refreshToken }
) {
  // ¿Ya existía el perfil? Sirve como proxy de "usuario nuevo" (registro) vs login.
  const { data: existing } = await userClient
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();

  const isNewUser = !existing;

  if (isNewUser) {
    // Crea la fila de perfil (sin depender de un trigger en auth.users).
    const { error: insErr } = await userClient.from('users').insert({
      id: user.id,
      business_name: businessName ?? null,
      business_category: businessCategory ?? null
    });
    if (insErr) return { isNewUser, error: insErr };
  } else if (businessName !== undefined || businessCategory !== undefined) {
    // Permite completar el perfil en el mismo paso si se envían datos.
    const patch = { last_modified: new Date().toISOString() };
    if (businessName !== undefined) patch.business_name = businessName ?? null;
    if (businessCategory !== undefined) patch.business_category = businessCategory ?? null;
    await userClient.from('users').update(patch).eq('id', user.id);
  }

  await upsertDevice(userClient, user.id, { hardwareDeviceId, deviceName, refreshToken });
  return { isNewUser, error: null };
}

/**
 * POST /auth/register
 * supabase.auth.signUp() + perfil en public.users + alta de dispositivo.
 * Body: { email, password, businessName, businessCategory, hardwareDeviceId, deviceName }
 */
exports.register = asyncHandler(async (req, res) => {
  const {
    email,
    password,
    businessName,
    businessCategory,
    hardwareDeviceId,
    deviceName
  } = req.body || {};

  if (!email || !password) {
    return fail(res, 400, 'email y password son obligatorios');
  }

  const { data, error } = await supabaseAnon.auth.signUp({ email, password });
  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  const user = data.user;
  const session = data.session;

  // Si signUp devuelve sesión (confirmación de email desactivada), seteamos
  // el perfil y el dispositivo con el token del nuevo usuario (bajo RLS).
  if (session && session.access_token) {
    const userClient = createUserClient(session.access_token);

    // Actualiza el perfil; si la fila aún no existe (sin trigger), la inserta.
    const profile = {
      business_name: businessName ?? null,
      business_category: businessCategory ?? null,
      last_modified: new Date().toISOString()
    };

    const { data: updated, error: updErr } = await userClient
      .from('users')
      .update(profile)
      .eq('id', user.id)
      .select('id');
    if (updErr) return fail(res, httpFromSupabaseError(updErr), updErr.message);

    if (!updated || updated.length === 0) {
      const { error: insErr } = await userClient.from('users').insert({
        id: user.id,
        business_name: businessName ?? null,
        business_category: businessCategory ?? null
      });
      if (insErr) return fail(res, httpFromSupabaseError(insErr), insErr.message);
    }

    await upsertDevice(userClient, user.id, {
      hardwareDeviceId,
      deviceName,
      refreshToken: session.refresh_token
    });
  }

  return ok(
    res,
    {
      user: user ? { id: user.id, email: user.email } : null,
      session: shapeSession(session),
      // Si no hay sesión, Supabase exige confirmar el email antes de iniciar sesión.
      emailConfirmationRequired: !session
    },
    201
  );
});

/**
 * POST /auth/login
 * supabase.auth.signInWithPassword() + alta/actualización de dispositivo.
 * Body: { email, password, hardwareDeviceId, deviceName }
 */
exports.login = asyncHandler(async (req, res) => {
  const { email, password, hardwareDeviceId, deviceName } = req.body || {};

  if (!email || !password) {
    return fail(res, 400, 'email y password son obligatorios');
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  const session = data.session;
  const userClient = createUserClient(session.access_token);

  await upsertDevice(userClient, data.user.id, {
    hardwareDeviceId,
    deviceName,
    refreshToken: session.refresh_token
  });

  return ok(res, {
    user: { id: data.user.id, email: data.user.email },
    session: shapeSession(session)
  });
});

/**
 * POST /auth/google
 * Sincroniza el perfil/dispositivo de un usuario que YA inició sesión con Google
 * a través del flujo OAuth gestionado por Supabase.
 *
 * La autenticación con Google se hace 100% en Supabase (Authentication -> Providers
 * -> Google). El cliente (p.ej. la web de pruebas) llama a
 * `supabase.auth.signInWithOAuth({ provider: 'google' })`; Supabase redirige a Google
 * y devuelve una sesión (access_token + refresh_token). El cliente manda aquí ese
 * access_token para que la API:
 *   1) lo verifique contra Supabase (getUser),
 *   2) cree la fila de perfil si es la primera vez (registro con Google),
 *   3) registre/actualice el dispositivo.
 *
 * Cubre TANTO registro (primer ingreso) como login (ingresos siguientes). Si el correo
 * de Google ya existía con email/password (Gmail verificado), Supabase enlaza la
 * identidad al mismo usuario, así que se entra al mismo perfil.
 *
 * La API ya NO necesita GOOGLE_CLIENT_ID ni llama a signInWithIdToken: Google se
 * configura por completo en Supabase.
 *
 * Body: { accessToken, refreshToken?, hardwareDeviceId?, deviceName?, businessName?, businessCategory? }
 *  - accessToken: JWT de la sesión que devolvió Supabase tras el login con Google.
 *  - refreshToken: opcional; se guarda hasheado en el dispositivo.
 */
exports.google = asyncHandler(async (req, res) => {
  const {
    accessToken,
    refreshToken,
    hardwareDeviceId,
    deviceName,
    businessName,
    businessCategory
  } = req.body || {};

  if (!accessToken) {
    return fail(res, 400, 'accessToken de la sesión de Supabase es obligatorio');
  }

  // Verifica el JWT que emitió Supabase tras el login con Google.
  const { data, error } = await supabaseAnon.auth.getUser(accessToken);
  if (error || !data || !data.user) {
    return fail(res, 401, 'La sesión de Google (Supabase) no es válida o expiró');
  }

  const user = data.user;
  const userClient = createUserClient(accessToken);

  const { isNewUser, error: syncErr } = await syncGoogleProfileAndDevice(userClient, user, {
    businessName,
    businessCategory,
    hardwareDeviceId,
    deviceName,
    refreshToken
  });
  if (syncErr) return fail(res, httpFromSupabaseError(syncErr), syncErr.message);

  return ok(res, {
    user: { id: user.id, email: user.email },
    // La sesión real ya la tiene el cliente (la creó Supabase); aquí solo la reflejamos.
    session: shapeSession({ access_token: accessToken, refresh_token: refreshToken ?? null }),
    isNewUser
  });
});

/**
 * POST /auth/google/idtoken  (público)
 * Login/registro con Google NATIVO en Android (Credential Manager / "One Tap"), sin
 * abrir navegador. El cliente obtiene un ID token de Google y lo envía aquí; la API lo
 * canjea por una sesión de Supabase con `signInWithIdToken`. Supabase verifica el token
 * contra los Client ID autorizados del provider Google (Authentication -> Providers ->
 * Google -> "Authorized Client IDs": añade ahí el Client ID Web y el de Android).
 *
 * A diferencia de POST /auth/google (que recibe un accessToken YA emitido por Supabase
 * tras el OAuth web), aquí la API CREA la sesión a partir del idToken, así que devuelve
 * accessToken + refreshToken reales de Supabase. Cubre registro (primer ingreso) y login.
 *
 * Body: { idToken, nonce?, hardwareDeviceId?, deviceName?, businessName?, businessCategory? }
 *  - idToken: JWT de Google (campo id_token de la credencial de Credential Manager).
 *  - nonce: el nonce EN CLARO usado al pedir la credencial (si se usó uno). Supabase lo
 *    hashea y lo compara con el del idToken. El client debe pasar al setNonce de Google
 *    el SHA-256 del nonce y enviar aquí el nonce en claro.
 */
exports.googleIdToken = asyncHandler(async (req, res) => {
  const {
    idToken,
    nonce,
    hardwareDeviceId,
    deviceName,
    businessName,
    businessCategory
  } = req.body || {};

  if (!idToken) {
    return fail(res, 400, 'idToken de Google es obligatorio');
  }

  // Canjea el idToken de Google por una sesión de Supabase (registro o login).
  const { data, error } = await supabaseAnon.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
    ...(nonce ? { nonce } : {})
  });
  if (error || !data || !data.session || !data.user) {
    const status = error ? httpFromSupabaseError(error) : 401;
    return fail(res, status, (error && error.message) || 'El idToken de Google no es válido o expiró');
  }

  const user = data.user;
  const session = data.session;
  const userClient = createUserClient(session.access_token);

  const { isNewUser, error: syncErr } = await syncGoogleProfileAndDevice(userClient, user, {
    businessName,
    businessCategory,
    hardwareDeviceId,
    deviceName,
    refreshToken: session.refresh_token
  });
  if (syncErr) return fail(res, httpFromSupabaseError(syncErr), syncErr.message);

  return ok(res, {
    user: { id: user.id, email: user.email },
    session: shapeSession(session),
    isNewUser
  });
});

/**
 * GET /auth/config  (público)
 * Expone configuración NO sensible para clientes (p.ej. la web de pruebas):
 * la URL y la anon key de Supabase (públicas) para que el cliente haga el login con
 * Google directamente contra Supabase, y qué métodos de autenticación están activos.
 */
exports.config = (req, res) => {
  return ok(res, {
    // Necesarias para crear un cliente Supabase en el navegador (anon key es pública).
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    // Google se gestiona por completo en Supabase; basta con tenerlo habilitado allí.
    googleEnabled: true,
    emailPasswordEnabled: true
  });
};

/**
 * POST /auth/refresh
 * supabase.auth.refreshSession({ refresh_token }).
 * Body: { refreshToken }
 */
exports.refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return fail(res, 400, 'refreshToken es obligatorio');

  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data || !data.session) {
    return fail(res, httpFromSupabaseError(error), (error && error.message) || 'No se pudo refrescar la sesión');
  }

  return ok(res, { session: shapeSession(data.session) });
});

/**
 * POST /auth/logout  (requiere JWT)
 * Revoca la sesión con el propio JWT del usuario (anon key + token, sin service_role)
 * y marca sus dispositivos como inactivos.
 */
exports.logout = asyncHandler(async (req, res) => {
  // admin.signOut(jwt) usa el JWT del usuario como Authorization; no requiere service_role.
  const { error } = await supabaseAnon.auth.admin.signOut(req.token, 'global');

  // status 404 => la sesión ya no existe; lo tratamos como logout exitoso.
  if (error && error.status !== 404) {
    return fail(res, httpFromSupabaseError(error), error.message);
  }

  // Mejor esfuerzo: desactiva los dispositivos del usuario.
  await req.supabase.from('user_devices').update({ is_active: false }).eq('user_id', req.user.id);

  return ok(res, { loggedOut: true });
});

/**
 * POST /auth/check-email  (público)
 * Indica si un correo YA está registrado y si está confirmado. Sirve para:
 *   - "evitar repetir correo en el registro": el cliente avisa antes de enviar el form.
 *   - "detectar correos no registrados" antes del login.
 * Body: { email } -> { exists, confirmed }
 * Requiere service_role (lee la lista de usuarios de Auth).
 *
 * NOTA de seguridad: exponer si un correo existe facilita la enumeración de usuarios.
 * Úsalo solo si tu caso lo justifica; si no, confía en el error de /auth/register o /login.
 */
exports.checkEmail = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return fail(res, 400, 'email es obligatorio');
  if (!supabaseAdmin) {
    return fail(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no está configurada en el servidor');
  }

  const found = await findAuthUserByEmail(email);
  return ok(res, {
    exists: Boolean(found),
    confirmed: found ? Boolean(found.email_confirmed_at || found.confirmed_at) : false
  });
});

/**
 * POST /auth/resend-verification  (público)
 * Reenvía el correo de verificación de registro (signup) a un usuario aún no confirmado.
 * Body: { email }
 */
exports.resendVerification = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return fail(res, 400, 'email es obligatorio');

  const { error } = await supabaseAnon.auth.resend({ type: 'signup', email });
  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  return ok(res, { sent: true });
});

/**
 * POST /auth/forgot-password  (público)
 * Envía el correo de restablecimiento de contraseña (Supabase resetPasswordForEmail).
 * Body: { email, redirectTo? }
 *  - redirectTo: URL a la que Supabase redirige tras hacer click (con un token de
 *    recuperación). Si no se envía, usa PASSWORD_RESET_REDIRECT_URL del .env.
 *
 * Por seguridad (anti-enumeración) responde 200 aunque el correo no exista.
 */
exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email, redirectTo } = req.body || {};
  if (!email) return fail(res, 400, 'email es obligatorio');

  const options = {};
  const target = redirectTo || process.env.PASSWORD_RESET_REDIRECT_URL;
  if (target) options.redirectTo = target;

  const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, options);
  // Solo propagamos fallos del servidor; no revelamos si el email existe.
  if (error && (error.status === undefined || error.status >= 500)) {
    return fail(res, httpFromSupabaseError(error), error.message);
  }

  return ok(res, { sent: true });
});

/**
 * POST /auth/reset-password  (público; necesita el token del enlace de recuperación)
 * Completa el cambio de contraseña. El flujo recomendado es que el cliente (web/app)
 * tras abrir el enlace de recuperación obtenga el accessToken de la sesión de recovery
 * y lo envíe aquí junto con la nueva contraseña.
 * Body: { accessToken, newPassword }
 * Requiere service_role.
 */
exports.resetPassword = asyncHandler(async (req, res) => {
  const { accessToken, newPassword } = req.body || {};
  if (!accessToken || !newPassword) {
    return fail(res, 400, 'accessToken y newPassword son obligatorios');
  }
  if (!supabaseAdmin) {
    return fail(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no está configurada en el servidor');
  }

  // Verifica el token de recuperación y obtiene a quién pertenece.
  const { data, error } = await supabaseAnon.auth.getUser(accessToken);
  if (error || !data || !data.user) {
    return fail(res, 401, 'El token de recuperación no es válido o expiró');
  }

  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, {
    password: newPassword
  });
  if (updErr) return fail(res, httpFromSupabaseError(updErr), updErr.message);

  return ok(res, { updated: true });
});

/**
 * DELETE /auth/account  (requiere JWT)
 * Elimina la cuenta del usuario y TODOS sus datos: content, visits, products,
 * user_devices y el perfil en users; luego elimina el usuario de Supabase Auth
 * (revoca sus sesiones). Requiere service_role.
 *
 * Borramos las tablas públicas de forma explícita por si el schema no tiene
 * ON DELETE CASCADE hacia auth.users.
 */
exports.deleteAccount = asyncHandler(async (req, res) => {
  if (!supabaseAdmin) {
    return fail(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no está configurada en el servidor');
  }

  const userId = req.user.id;

  // 1) Datos del usuario en las tablas de la app.
  const userTables = ['content', 'visits', 'products', 'user_devices'];
  for (const table of userTables) {
    const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
    if (error) {
      return fail(res, httpFromSupabaseError(error), `Error borrando ${table}: ${error.message}`);
    }
  }

  // 2) Perfil (PK = id).
  const { error: profileErr } = await supabaseAdmin.from('users').delete().eq('id', userId);
  if (profileErr) {
    return fail(res, httpFromSupabaseError(profileErr), `Error borrando perfil: ${profileErr.message}`);
  }

  // 3) Usuario de Auth (revoca sesiones).
  const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (delErr) {
    return fail(res, httpFromSupabaseError(delErr), `Error eliminando la cuenta: ${delErr.message}`);
  }

  return ok(res, { deleted: true, userId });
});
