'use strict';

require('dotenv').config();

// Node < 22 no trae WebSocket nativo. Al crear el cliente, supabase-js inicializa
// realtime-js, que exige un WebSocket global aunque NO usemos realtime aquí.
// Aportamos un polyfill con "ws" para soportar Node 18/20 (en Node 22+ ya existe nativo).
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch (_) {
    /* En Node 22+ existe WebSocket nativo y este polyfill no es necesario. */
  }
}

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Faltan variables de entorno: SUPABASE_URL y/o SUPABASE_ANON_KEY. Revisa tu archivo .env'
  );
}

// Opciones comunes: en un servidor no persistimos ni auto-refrescamos sesiones.
const baseAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
};

/**
 * Cliente con ANON key.
 * Se usa para TODA la autenticación de usuarios:
 * signUp, signInWithPassword, refreshSession, getUser y signOut.
 */
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, baseAuthOptions);

/**
 * Cliente con SERVICE_ROLE key.
 * SOLO se usa en /sync/migrate (bypassa RLS para hacer el batch atómico).
 * Es null si no se configuró la clave; los controladores lo validan.
 */
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, baseAuthOptions)
  : null;

/**
 * Crea un cliente Supabase "por petición" que adjunta el JWT del usuario.
 * Así PostgREST aplica las políticas RLS con auth.uid() = el usuario autenticado.
 * @param {string} accessToken - JWT del usuario (Bearer token).
 */
function createUserClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    ...baseAuthOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

module.exports = {
  supabaseAnon,
  supabaseAdmin,
  createUserClient,
  SUPABASE_URL
};
