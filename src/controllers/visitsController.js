'use strict';

const { ok, fail, httpFromSupabaseError, asyncHandler, rowToCamel, toIso } = require('../utils/helpers');
const { triggerBackground } = require('../services/contentGenerator');

/**
 * GET /visits
 * Paginado. Query params: ?page=1&limit=20&from=timestamp&to=timestamp
 * from/to admiten ISO o milisegundos; filtran por registration_date.
 */
exports.list = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const fromRange = (page - 1) * limit;
  const toRange = fromRange + limit - 1;

  let query = req.supabase
    .from('visits')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user.id);

  if (req.query.from) {
    const fromIso = toIso(req.query.from);
    if (fromIso) query = query.gte('registration_date', fromIso);
  }
  if (req.query.to) {
    const toIsoVal = toIso(req.query.to);
    if (toIsoVal) query = query.lte('registration_date', toIsoVal);
  }

  query = query.order('registration_date', { ascending: false }).range(fromRange, toRange);

  const { data, error, count } = await query;
  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  return ok(res, {
    items: rowToCamel(data),
    page,
    limit,
    total: count ?? 0,
    totalPages: count ? Math.ceil(count / limit) : 0
  });
});

/**
 * POST /visits
 * registrationDate llega como Long (ms) desde Android -> se convierte a ISO.
 */
exports.create = asyncHandler(async (req, res) => {
  const b = req.body || {};

  const registrationDate =
    b.registrationDate != null ? toIso(b.registrationDate) : new Date().toISOString();

  // Idempotencia: si ya existe una visita con este (user_id, registration_date),
  // la devolvemos en lugar de insertar. Evita duplicados cuando dos dispositivos
  // de la misma cuenta suben la misma visita compartida por P2P. La unicidad dura
  // la garantiza el índice visits_user_regdate_unique (ver sql/visits_dedup.sql).
  if (registrationDate) {
    const { data: existing, error: findErr } = await req.supabase
      .from('visits')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('registration_date', registrationDate)
      .order('id', { ascending: true })
      .limit(1);
    if (findErr) return fail(res, httpFromSupabaseError(findErr), findErr.message);
    if (existing && existing.length) return ok(res, rowToCamel(existing[0]), 200);
  }

  const payload = {
    user_id: req.user.id,
    device_id: b.deviceId ?? null,
    nationality: b.nationality ?? null,
    nationality_flag: b.nationalityFlag ?? null,
    selected_products: b.selectedProducts ?? [], // JSONB: se guarda tal cual
    subtotal: b.subtotal ?? null,
    discount_value: b.discountValue ?? null,
    discount_type: b.discountType ?? null,
    total_amount: b.totalAmount ?? null,
    currency: b.currency ?? null,
    registration_date: registrationDate,
    is_sent: b.isSent ?? false,
    sent_date: b.sentDate != null ? toIso(b.sentDate) : null
  };

  const { data, error } = await req.supabase
    .from('visits')
    .insert(payload)
    .select()
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);

  triggerBackground(req.user.id, 'visit-create');
  return ok(res, rowToCamel(data), 201);
});

/**
 * GET /visits/:id
 * SELECT WHERE id = :id AND user_id = req.user.id
 */
exports.getOne = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await req.supabase
    .from('visits')
    .select('*')
    .eq('id', id)
    .eq('user_id', req.user.id)
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  return ok(res, rowToCamel(data));
});

/**
 * PUT /visits/:id  (actualización de una visita)
 * registrationDate, si se envía, llega como Long (ms) y se convierte a ISO.
 */
exports.update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};

  const payload = {
    device_id: b.deviceId ?? null,
    nationality: b.nationality ?? null,
    nationality_flag: b.nationalityFlag ?? null,
    selected_products: b.selectedProducts ?? [],
    subtotal: b.subtotal ?? null,
    discount_value: b.discountValue ?? null,
    discount_type: b.discountType ?? null,
    total_amount: b.totalAmount ?? null,
    currency: b.currency ?? null,
    is_sent: b.isSent ?? false,
    sent_date: b.sentDate != null ? toIso(b.sentDate) : null
  };
  // registration_date solo se reescribe si el cliente lo envía (es la clave de dedup).
  if (b.registrationDate != null) payload.registration_date = toIso(b.registrationDate);

  const { data, error } = await req.supabase
    .from('visits')
    .update(payload)
    .eq('id', id)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  if (!data) return fail(res, 404, 'Visita no encontrada');

  triggerBackground(req.user.id, 'visit-update');
  return ok(res, rowToCamel(data));
});

/**
 * DELETE /visits/:id
 */
exports.remove = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await req.supabase
    .from('visits')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user.id)
    .select();

  if (error) return fail(res, httpFromSupabaseError(error), error.message);
  if (!data || data.length === 0) return fail(res, 404, 'Visita no encontrada');

  triggerBackground(req.user.id, 'visit-delete');
  return ok(res, { deleted: true, id });
});
