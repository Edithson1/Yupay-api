'use strict';

const { ok, fail, httpFromSupabaseError, asyncHandler, rowToCamel } = require('../utils/helpers');

/**
 * GET /devices
 * SELECT * FROM user_devices WHERE user_id = req.user.id
 */
exports.list = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', req.user.id)
    .order('last_login', { ascending: false });

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  return ok(res, rowToCamel(data));
});

/**
 * DELETE /devices/:id
 * DELETE FROM user_devices WHERE id = :id AND user_id = req.user.id
 */
exports.remove = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await req.supabase
    .from('user_devices')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user.id)
    .select();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  if (!data || data.length === 0) return fail(res, 404, 'Dispositivo no encontrado');

  return ok(res, { deleted: true, id });
});
