'use strict';

const { ok, fail, httpFromSupabaseError, asyncHandler, rowToCamel } = require('../utils/helpers');
const { maybeGenerate, triggerBackground, inspect } = require('../services/contentGenerator');

/**
 * GET /content
 * SELECT * FROM content WHERE user_id = req.user.id
 */
exports.list = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('content')
    .select('*')
    .eq('user_id', req.user.id);

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  return ok(res, rowToCamel(data));
});

/**
 * PUT /content
 * UPSERT por (user_id, language, type).
 * Body: { language, type, content, audioBase64 }
 * Requiere un índice/constraint UNIQUE en (user_id, language, type).
 */
exports.upsert = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.language || !b.type) {
    return fail(res, 400, 'language y type son obligatorios');
  }

  const payload = {
    user_id: req.user.id,
    language: b.language,
    type: b.type,
    content: b.content ?? null,
    audio_base64: b.audioBase64 ?? null,
    last_modified: new Date().toISOString()
  };

  const { data, error } = await req.supabase
    .from('content')
    .upsert(payload, { onConflict: 'user_id,language,type' })
    .select()
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  // El upsert manual de contenido también cuenta como "datos actualizados":
  // re-evalúa el gating por si toca regenerar con IA (en segundo plano).
  triggerBackground(req.user.id, 'content-upsert');

  return ok(res, rowToCamel(data));
});

/**
 * POST /content/generate
 * Genera el contenido (map + tip x 4 idiomas) con IA. Respeta el gating de
 * costos; usa ?force=true (o body { force: true }) para forzar la regeneración.
 * Devuelve el resumen de la operación de forma SÍNCRONA (útil para probar).
 */
exports.generate = asyncHandler(async (req, res) => {
  const force = req.query.force === 'true' || (req.body && req.body.force === true);
  const result = await maybeGenerate(req.user.id, { force, reason: 'manual' });
  if (result.error) return fail(res, 502, `Generación de contenido falló: ${result.error}`);
  return ok(res, result);
});

/**
 * GET /content/status
 * Indica si correspondería regenerar (sin llamar a la IA) y por qué.
 */
exports.status = asyncHandler(async (req, res) => {
  const info = await inspect(req.user.id);
  if (info.error) return fail(res, 500, info.error);
  return ok(res, info);
});
