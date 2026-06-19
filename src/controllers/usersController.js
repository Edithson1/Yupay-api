'use strict';

const { ok, fail, httpFromSupabaseError, asyncHandler, rowToCamel } = require('../utils/helpers');
const { triggerBackground } = require('../services/contentGenerator');

/**
 * GET /users/me
 * SELECT * FROM public.users WHERE id = req.user.id (RLS también lo garantiza).
 */
exports.getMe = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('users')
    .select('*')
    .eq('id', req.user.id)
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  return ok(res, rowToCamel(data));
});

/**
 * PATCH /users/me
 * Actualización parcial. Campos permitidos: business_name, business_category, profile_picture.
 * Body camelCase: { businessName?, businessCategory?, profilePicture? }
 */
exports.updateMe = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const fieldMap = {
    businessName: 'business_name',
    businessCategory: 'business_category',
    profilePicture: 'profile_picture'
  };

  const update = {};
  for (const [camel, snake] of Object.entries(fieldMap)) {
    if (body[camel] !== undefined) update[snake] = body[camel];
  }

  if (Object.keys(update).length === 0) {
    return fail(res, 400, 'No se enviaron campos válidos para actualizar');
  }
  update.last_modified = new Date().toISOString();

  const { data, error } = await req.supabase
    .from('users')
    .update(update)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  // Si cambió nombre/sector del emprendimiento, el gating lo detectará y regenerará
  // el contenido con IA (en segundo plano). Otros cambios de perfil no disparan IA.
  if (body.businessName !== undefined || body.businessCategory !== undefined) {
    triggerBackground(req.user.id, 'profile-update');
  }

  return ok(res, rowToCamel(data));
});
