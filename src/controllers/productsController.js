'use strict';

const { ok, fail, httpFromSupabaseError, asyncHandler, rowToCamel, toIso } = require('../utils/helpers');
const { triggerBackground } = require('../services/contentGenerator');

/**
 * Mapea el body camelCase a la fila snake_case de la tabla products.
 */
function mapProductIn(body, userId) {
  return {
    user_id: userId,
    name: body.name ?? null,
    base_price: body.basePrice ?? null,
    currency: body.currency ?? null,
    category: body.category ?? null,
    is_default: body.isDefault ?? false,
    discount_value: body.discountValue ?? null,
    discount_type: body.discountType ?? null,
    // timestamptz: aceptar epoch ms o ISO (toIso normaliza ambos).
    discount_start_date: body.discountStartDate != null ? toIso(body.discountStartDate) : null,
    discount_end_date: body.discountEndDate != null ? toIso(body.discountEndDate) : null,
    last_modified: new Date().toISOString()
  };
}

/**
 * GET /products
 * SELECT * FROM products WHERE user_id = req.user.id ORDER BY created_at DESC
 */
exports.list = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('products')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  return ok(res, rowToCamel(data));
});

/**
 * POST /products
 */
exports.create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return fail(res, 400, 'name es obligatorio');

  const payload = mapProductIn(body, req.user.id);

  const { data, error } = await req.supabase
    .from('products')
    .insert(payload)
    .select()
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  triggerBackground(req.user.id, 'product-create');
  return ok(res, rowToCamel(data), 201);
});

/**
 * PUT /products/:id  (actualización completa del producto)
 */
exports.update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payload = mapProductIn(req.body || {}, req.user.id);
  delete payload.user_id; // no se reasigna el propietario

  const { data, error } = await req.supabase
    .from('products')
    .update(payload)
    .eq('id', id)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  if (!data) return fail(res, 404, 'Producto no encontrado');

  triggerBackground(req.user.id, 'product-update');
  return ok(res, rowToCamel(data));
});

/**
 * DELETE /products/:id
 */
exports.remove = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await req.supabase
    .from('products')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user.id)
    .select();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  if (!data || data.length === 0) return fail(res, 404, 'Producto no encontrado');

  // Tombstone: registra el borrado para que el /sync/pull lo propague a otros
  // dispositivos. Best-effort: si la tabla `deletions` aún no existe (migración
  // pendiente), no rompemos el borrado (solo no se propagará hasta aplicar el SQL).
  const { error: tombErr } = await req.supabase
    .from('deletions')
    .upsert(
      { user_id: req.user.id, entity_type: 'product', remote_id: Number(id) },
      { onConflict: 'user_id,entity_type,remote_id', ignoreDuplicates: true }
    );
  if (tombErr) console.error('[deletions] tombstone de producto no registrado:', tombErr.message);

  triggerBackground(req.user.id, 'product-delete');
  return ok(res, { deleted: true, id });
});
