'use strict';

const crypto = require('crypto');
const { supabaseAnon, supabaseAdmin, createUserClient } = require('../config/supabase');
const { ok, fail, httpFromSupabaseError, asyncHandler, decodeJwtPayload } = require('../utils/helpers');

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

/**
 * ¿El usuario tiene una identidad de email/contraseña (es decir, se registró con
 * contraseña) y no solo con un proveedor OAuth como Google?
 * Supabase marca el proveedor 'email' en `app_metadata.providers` y en `identities`.
 * Se usa en /auth/forgot-password: el código de recuperación solo tiene sentido para
 * cuentas con contraseña (las de solo-Google no tienen contraseña que restablecer).
 */
function userHasPasswordIdentity(user) {
  if (!user) return false;
  const providers = (user.app_metadata && user.app_metadata.providers) || [];
  if (Array.isArray(providers) && providers.includes('email')) return true;
  const identities = user.identities || [];
  return identities.some((i) => i && i.provider === 'email');
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
 *
 * Compatibilidad con el Client ID de Android: este endpoint NO fija ningún Client ID; el
 * `aud` (audiencia) del idToken lo valida Supabase contra el provider Google. Para aceptar
 * tanto el Client ID *Web* (serverClientId recomendado) como el de *Android*, añade AMBOS en
 * Supabase -> Authentication -> Providers -> Google -> "Authorized Client IDs" (admite varios
 * separados por coma). Si defines GOOGLE_WEB_CLIENT_ID / GOOGLE_ANDROID_CLIENT_ID en el .env,
 * además hacemos una pre-validación del `aud` aquí para dar un error claro antes de Supabase.
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

  // Pre-validación OPCIONAL de la audiencia (solo si configuraste los Client ID en el .env):
  // comprobamos que el idToken fue emitido para un Client ID conocido ANTES de llamar a
  // Supabase, para dar un mensaje accionable. La verificación criptográfica real (firma de
  // Google + audiencia autorizada) la sigue haciendo Supabase en signInWithIdToken.
  const allowedAudiences = [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID
  ].filter(Boolean);
  if (allowedAudiences.length) {
    const payload = decodeJwtPayload(idToken);
    const aud = payload && payload.aud;
    if (aud && !allowedAudiences.includes(aud)) {
      return fail(
        res,
        401,
        `El idToken de Google se emitió para un Client ID no autorizado (aud=${aud}). ` +
          'Usa el Client ID Web como serverClientId en la app y registra ese Client ID (y el de ' +
          'Android) en Supabase -> Authentication -> Providers -> Google -> "Authorized Client IDs".'
      );
    }
  }

  // Canjea el idToken de Google por una sesión de Supabase (registro o login).
  const { data, error } = await supabaseAnon.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
    ...(nonce ? { nonce } : {})
  });
  if (error || !data || !data.session || !data.user) {
    const status = error ? httpFromSupabaseError(error) : 401;
    let message = (error && error.message) || 'El idToken de Google no es válido o expiró';
    // El error típico cuando el Client ID del token no está autorizado en Supabase.
    if (error && /audience|client.?id|\baud\b|not enabled|unauthorized|provider/i.test(error.message || '')) {
      message +=
        ' · Revisa que el Client ID (Web y/o Android) esté en Supabase -> Authentication -> ' +
        'Providers -> Google -> "Authorized Client IDs".';
    }
    return fail(res, status, message);
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
    emailPasswordEnabled: true,
    // Client ID de Google (PÚBLICOS). La app Android usa `googleWebClientId` como
    // serverClientId de Credential Manager; el de Android (package + SHA-1) autoriza la app.
    // Ambos deben estar en Supabase -> Authentication -> Providers -> Google ->
    // "Authorized Client IDs" (ese campo admite varios separados por coma).
    googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID || null,
    googleAndroidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID || null
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
 * Inicia la recuperación de contraseña por CÓDIGO de 6 dígitos (OTP), no por enlace.
 * Body: { email }
 *
 * Flujo:
 *   1) Solo se envía el código si el correo está registrado y tiene CONTRASEÑA (identidad
 *      'email'). Si no existe o es una cuenta de solo-Google, NO se envía nada y se devuelve
 *      un mensaje explicando por qué (data.sent = false, data.reason).
 *   2) Supabase manda el correo con resetPasswordForEmail. Para que el correo traiga el
 *      código de 6 dígitos (en vez de un enlace), la plantilla "Reset Password" de Supabase
 *      (Authentication -> Email Templates) debe incluir {{ .Token }}.
 *   3) El código se valida luego en POST /auth/verify-reset-code.
 *
 * Requiere service_role (para consultar si el correo existe y tiene contraseña).
 *
 * NOTA: comprobar si un correo existe permite enumeración de usuarios; es una decisión de
 * producto (la UI necesita avisar "este correo no está registrado").
 */
exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return fail(res, 400, 'email es obligatorio');
  if (!supabaseAdmin) {
    return fail(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no está configurada en el servidor');
  }

  const user = await findAuthUserByEmail(email);
  if (!user) {
    return ok(res, {
      sent: false,
      reason: 'not_registered',
      message: 'No hay ninguna cuenta registrada con este correo.'
    });
  }
  if (!userHasPasswordIdentity(user)) {
    return ok(res, {
      sent: false,
      reason: 'oauth_only',
      message: 'Esta cuenta inicia sesión con Google y no tiene contraseña que restablecer.'
    });
  }

  // Envía el correo de recuperación. Sin redirectTo: el flujo es por código (OTP), el enlace
  // de redirección ya no se usa. El código de 6 dígitos sale de {{ .Token }} en la plantilla.
  const { error } = await supabaseAnon.auth.resetPasswordForEmail(email);
  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  return ok(res, {
    sent: true,
    reason: 'sent',
    message: 'Te enviamos un código a tu correo para restablecer la contraseña.'
  });
});

/**
 * POST /auth/verify-reset-code  (público)
 * Comprueba la validez del código de 6 dígitos (OTP de recuperación).
 * Body: { email, code }
 *
 * verifyOtp(type:'recovery') valida y CONSUME el código; si es válido devuelve una sesión de
 * recuperación. Devolvemos su accessToken para que el cliente complete el cambio en
 * POST /auth/reset-password SIN reenviar el código (ya consumido).
 *  - 200 { valid: true, session, user }  -> código correcto.
 *  - 400 { error }                       -> código inválido o expirado.
 */
exports.verifyResetCode = asyncHandler(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return fail(res, 400, 'email y code son obligatorios');

  const { data, error } = await supabaseAnon.auth.verifyOtp({
    email,
    token: String(code).trim(),
    type: 'recovery'
  });
  if (error || !data || !data.session) {
    return fail(res, 400, 'El código es inválido o expiró. Solicita uno nuevo.');
  }

  return ok(res, {
    valid: true,
    session: shapeSession(data.session),
    user: data.user ? { id: data.user.id, email: data.user.email } : null
  });
});

/**
 * POST /auth/reset-password  (público; necesita probar la recuperación)
 * Completa el cambio de contraseña. Dos formas de identificar al usuario:
 *   (A) { accessToken, newPassword }   -> accessToken de la sesión de recuperación
 *                                          (el que devuelve POST /auth/verify-reset-code).
 *   (B) { email, code, newPassword }   -> atajo de un paso: valida el código aquí mismo.
 * Requiere service_role.
 */
exports.resetPassword = asyncHandler(async (req, res) => {
  const { accessToken, email, code, newPassword } = req.body || {};
  if (!newPassword) return fail(res, 400, 'newPassword es obligatorio');
  if (!supabaseAdmin) {
    return fail(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no está configurada en el servidor');
  }

  let userId = null;

  if (accessToken) {
    // (A) Verifica la sesión de recuperación y obtiene a quién pertenece.
    const { data, error } = await supabaseAnon.auth.getUser(accessToken);
    if (error || !data || !data.user) {
      return fail(res, 401, 'La sesión de recuperación no es válida o expiró');
    }
    userId = data.user.id;
  } else if (email && code) {
    // (B) Valida (y consume) el código directamente.
    const { data, error } = await supabaseAnon.auth.verifyOtp({
      email,
      token: String(code).trim(),
      type: 'recovery'
    });
    if (error || !data || !data.user) {
      return fail(res, 400, 'El código es inválido o expiró. Solicita uno nuevo.');
    }
    userId = data.user.id;
  } else {
    return fail(res, 400, 'Envía { accessToken } (de verify-reset-code) o { email, code }');
  }

  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
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
