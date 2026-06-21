'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, httpFromSupabaseError, asyncHandler, rowToCamel, toIso } = require('../utils/helpers');
const { triggerBackground } = require('../services/contentGenerator');

// ---- Mapeadores camelCase -> snake_case ----
function mapProductRow(p, userId) {
  const row = {
    user_id: userId,
    name: p.name ?? null,
    base_price: p.basePrice ?? null,
    currency: p.currency ?? null,
    category: p.category ?? null,
    is_default: p.isDefault ?? false,
    discount_value: p.discountValue ?? null,
    discount_type: p.discountType ?? null,
    // timestamptz: aceptar epoch ms o ISO (toIso normaliza ambos), igual que registration_date.
    discount_start_date: p.discountStartDate != null ? toIso(p.discountStartDate) : null,
    discount_end_date: p.discountEndDate != null ? toIso(p.discountEndDate) : null,
    last_modified: new Date().toISOString()
  };
  return row;
}

function mapVisitRow(v, userId) {
  return {
    user_id: userId,
    device_id: v.deviceId ?? null,
    nationality: v.nationality ?? null,
    nationality_flag: v.nationalityFlag ?? null,
    selected_products: v.selectedProducts ?? [],
    subtotal: v.subtotal ?? null,
    discount_value: v.discountValue ?? null,
    discount_type: v.discountType ?? null,
    total_amount: v.totalAmount ?? null,
    currency: v.currency ?? null,
    registration_date: v.registrationDate != null ? toIso(v.registrationDate) : new Date().toISOString(),
    is_sent: v.isSent ?? false,
    sent_date: v.sentDate != null ? toIso(v.sentDate) : null
  };
}

function mapContentRow(c, userId) {
  return {
    user_id: userId,
    language: c.language,
    type: c.type,
    content: c.content ?? null,
    audio_base64: c.audioBase64 ?? null,
    last_modified: new Date().toISOString()
  };
}

/**
 * POST /sync/migrate
 * Migración inicial. Usa el cliente service_role para el batch.
 * Body: { profile, products[], visits[], content[] }
 *
 * NOTA sobre atomicidad: supabase-js no expone transacciones multi-sentencia.
 * Implementamos "todo o nada" con rollback de mejor esfuerzo (borramos lo insertado
 * si un paso falla). Para atomicidad real, mover esta lógica a una función Postgres
 * (RPC) y llamarla con supabaseAdmin.rpc(...). Ver README.
 */
exports.migrate = asyncHandler(async (req, res) => {
  if (!supabaseAdmin) {
    return fail(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no está configurada en el servidor');
  }

  const userId = req.user.id;
  const { profile, products = [], visits = [], content = [] } = req.body || {};

  const insertedProductIds = [];
  const insertedVisitIds = [];
  let contentCount = 0;

  // Diagnóstico: en qué paso vamos, para saber qué parte del schema falla.
  let step = 'inicio';

  try {
    // 1) Perfil (upsert; service_role bypassa RLS).
    if (profile) {
      step = 'profile (users upsert)';
      const { error } = await supabaseAdmin.from('users').upsert(
        {
          id: userId,
          business_name: profile.businessName ?? null,
          business_category: profile.businessCategory ?? null,
          profile_picture: profile.profilePicture ?? null,
          last_modified: new Date().toISOString()
        },
        { onConflict: 'id' }
      );
      if (error) throw error;
    }

    // 2) Products en batch.
    if (products.length) {
      step = 'products (insert)';
      const rows = products.map((p) => mapProductRow(p, userId));
      const { data, error } = await supabaseAdmin.from('products').insert(rows).select('id');
      if (error) throw error;
      insertedProductIds.push(...data.map((r) => r.id));
    }

    // 3) Visits en batch (registrationDate ms -> ISO dentro de mapVisitRow).
    if (visits.length) {
      step = 'visits (insert)';
      const rows = visits.map((v) => mapVisitRow(v, userId));
      const { data, error } = await supabaseAdmin.from('visits').insert(rows).select('id');
      if (error) throw error;
      insertedVisitIds.push(...data.map((r) => r.id));
    }

    // 4) Content (upsert por user_id, language, type).
    if (content.length) {
      step = 'content (upsert onConflict user_id,language,type)';
      const rows = content.map((c) => mapContentRow(c, userId));
      const { error } = await supabaseAdmin.from('content').upsert(rows, { onConflict: 'user_id,language,type' });
      if (error) throw error;
      contentCount = rows.length;
    }

    // Primera subida (o re-migración): evalúa generar contenido con IA (en segundo plano).
    triggerBackground(userId, 'migrate');

    return ok(
      res,
      {
        inserted: {
          profile: profile ? 1 : 0,
          products: insertedProductIds.length,
          visits: insertedVisitIds.length,
          content: contentCount
        }
      },
      201
    );
  } catch (error) {
    // Rollback de mejor esfuerzo: borra lo que sí se insertó en este request.
    if (insertedVisitIds.length) {
      await supabaseAdmin.from('visits').delete().in('id', insertedVisitIds);
    }
    if (insertedProductIds.length) {
      await supabaseAdmin.from('products').delete().in('id', insertedProductIds);
    }

    // Diagnóstico completo en el log del servidor (code/details/hint de Postgres).
    console.error('[MIGRATE] Falló en el paso:', step, {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });

    return fail(
      res,
      httpFromSupabaseError(error),
      `Migración revertida en el paso "${step}": ${error.message}` +
        (error.code ? ` (code ${error.code})` : '') +
        (error.details ? ` — ${error.details}` : '') +
        (error.hint ? ` — hint: ${error.hint}` : '')
    );
  }
});

/**
 * POST /sync/push
 * Sube cambios locales pendientes. Body: { products[], visits[] }
 * - products: upsert por id (los nuevos sin id se insertan).
 * - visits: dedup por registration_date (no inserta si ya existe ese timestamp para el user).
 * Usa el cliente con RLS del usuario (req.supabase).
 */
exports.push = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { products = [], visits = [] } = req.body || {};
  const result = {
    products: { upserted: 0 },
    visits: { inserted: 0, skipped: 0 }
  };

  // ---- PRODUCTS: upsert por id ----
  if (products.length) {
    const rows = products.map((p) => {
      const row = mapProductRow(p, userId);
      if (p.id != null) row.id = p.id;
      return row;
    });

    const { data, error } = await req.supabase
      .from('products')
      .upsert(rows, { onConflict: 'id' })
      .select('id');

    if (error) return fail(res, httpFromSupabaseError(error), error.message);
    result.products.upserted = data ? data.length : 0;
  }

  // ---- VISITS: dedup por registration_date ----
  if (visits.length) {
    const normalized = visits.map((v) => ({
      raw: v,
      iso: v.registrationDate != null ? toIso(v.registrationDate) : null
    }));

    const isos = normalized.map((n) => n.iso).filter(Boolean);
    let existing = new Set();

    if (isos.length) {
      const { data: rows, error } = await req.supabase
        .from('visits')
        .select('registration_date')
        .eq('user_id', userId)
        .in('registration_date', isos);

      if (error) return fail(res, httpFromSupabaseError(error), error.message);
      existing = new Set((rows || []).map((r) => new Date(r.registration_date).toISOString()));
    }

    const toInsert = normalized.filter((n) => n.iso && !existing.has(n.iso));
    result.visits.skipped = normalized.length - toInsert.length;

    if (toInsert.length) {
      const rows = toInsert.map((n) => {
        const row = mapVisitRow(n.raw, userId);
        row.registration_date = n.iso; // ya normalizado
        return row;
      });

      const { data, error } = await req.supabase.from('visits').insert(rows).select('id');
      if (error) return fail(res, httpFromSupabaseError(error), error.message);
      result.visits.inserted = data ? data.length : 0;
    }
  }

  // Se subieron cambios de productos/visitas: evalúa regenerar contenido (en segundo plano).
  triggerBackground(userId, 'push');

  return ok(res, result);
});

/**
 * GET /sync/pull?since=<ISO>
 * Devuelve cambios desde "since": { user, products[], visits[], content[] }.
 * products/content filtran por last_modified > since; visits por registration_date > since.
 * Sin "since" devuelve todo.
 */
exports.pull = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const since = req.query.since ? toIso(req.query.since) : null;

  const { data: user, error: userErr } = await req.supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) return fail(res, httpFromSupabaseError(userErr), userErr.message);

  let productsQuery = req.supabase.from('products').select('*').eq('user_id', userId);
  let visitsQuery = req.supabase.from('visits').select('*').eq('user_id', userId);
  let contentQuery = req.supabase.from('content').select('*').eq('user_id', userId);

  if (since) {
    productsQuery = productsQuery.gt('last_modified', since);
    visitsQuery = visitsQuery.gt('registration_date', since);
    contentQuery = contentQuery.gt('last_modified', since);
  }

  const [productsRes, visitsRes, contentRes] = await Promise.all([
    productsQuery,
    visitsQuery,
    contentQuery
  ]);

  if (productsRes.error) return fail(res, httpFromSupabaseError(productsRes.error), productsRes.error.message);
  if (visitsRes.error) return fail(res, httpFromSupabaseError(visitsRes.error), visitsRes.error.message);
  if (contentRes.error) return fail(res, httpFromSupabaseError(contentRes.error), contentRes.error.message);

  return ok(res, {
    user: user ? rowToCamel(user) : null,
    products: rowToCamel(productsRes.data),
    visits: rowToCamel(visitsRes.data),
    content: rowToCamel(contentRes.data)
  });
});
