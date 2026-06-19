'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Generador de "content" (map + tip) con IA (Gemini)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Flujo:
 *    1. Se dispara cuando el usuario sube/actualiza datos (migrate, push,
 *       crear visita, crear/editar/borrar producto, cambiar perfil).
 *    2. Para AHORRAR COSTOS de IA, solo se llama a Gemini si se cumple
 *       AL MENOS UNA condición (gating) desde la última generación:
 *         - primera generación (nunca se generó),
 *         - >= CONTENT_MIN_NEW_VISITS visitas nuevas,
 *         - pasó >= CONTENT_REGEN_DAYS días (≈ 1 mes),
 *         - cambio "masivo" en productos (>= CONTENT_MIN_PRODUCT_CHANGES
 *           altas/bajas/ediciones),
 *         - cambió el nombre del emprendimiento,
 *         - cambió el sector/categoría del emprendimiento.
 *    3. Genera EXACTAMENTE 8 registros = 2 tipos (map, tip) x 4 idiomas
 *       (Español, Quechua, Portugués, Inglés) y los hace upsert en `content`.
 *    4. Guarda metadatos de la generación en `users` para el próximo gating.
 *
 *  El servicio NUNCA rompe el request principal: si falta la API key,
 *  Gemini falla, etc., se registra en consola y se continúa.
 * ═══════════════════════════════════════════════════════════════════
 */

const { supabaseAdmin } = require('../config/supabase');

// ---- Configuración (overridable por .env) ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const MIN_NEW_VISITS = parseInt(process.env.CONTENT_MIN_NEW_VISITS, 10) || 10;
const MIN_PRODUCT_CHANGES = parseInt(process.env.CONTENT_MIN_PRODUCT_CHANGES, 10) || 3;
const REGEN_DAYS = parseInt(process.env.CONTENT_REGEN_DAYS, 10) || 30;

// ---- Combinaciones obligatorias (2 tipos x 4 idiomas = 8) ----
const LANGS = ['Español', 'Quechua', 'Portugués', 'Inglés'];
const TYPES = ['map', 'tip'];

// Mapeo clave-JSON -> etiqueta de idioma que se guarda en la columna `language`.
const LANG_MAP = [
  { key: 'espanol', label: 'Español' },
  { key: 'quechua', label: 'Quechua' },
  { key: 'portugues', label: 'Portugués' },
  { key: 'ingles', label: 'Inglés' }
];

// Cada idioma DEBE traer ambos textos (tip + map): ambos son `required`.
const LANG_NODE = {
  type: 'object',
  properties: {
    tip: { type: 'string' },
    map: { type: 'string' }
  },
  required: ['tip', 'map'],
  propertyOrdering: ['tip', 'map']
};

// Esquema de salida estructurada: un objeto con los 4 idiomas, todos obligatorios.
// Al ser `required`, el modelo NO puede omitir ninguno -> siempre 8 textos en 1 sola petición.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    espanol: LANG_NODE,
    quechua: LANG_NODE,
    portugues: LANG_NODE,
    ingles: LANG_NODE
  },
  required: ['espanol', 'quechua', 'portugues', 'ingles'],
  propertyOrdering: ['espanol', 'quechua', 'portugues', 'ingles']
};

// Candado en memoria: evita generaciones concurrentes para el mismo usuario.
const inFlight = new Set();

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

// Firma por producto: cualquier alta/baja/edición cambia el conjunto.
function productSigs(products) {
  return products.map(
    (p) => `${p.name}|${p.category}|${p.base_price}|${p.discount_value}|${p.discount_type}`
  );
}

function symmetricDiff(a, b) {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  for (const x of b) if (!a.has(x)) n++;
  return n;
}

/**
 * Evalúa el gating: ¿debemos regenerar? Devuelve la lista de disparadores.
 */
function evaluate(user, products, visitCount, force) {
  const triggers = [];
  const lastGen = user.content_last_generated_at ? new Date(user.content_last_generated_at) : null;

  if (force) triggers.push('force');
  if (!lastGen) {
    triggers.push('primera-generacion');
    return { should: true, triggers };
  }

  // 1 mes (o lo configurado) desde la última generación.
  const days = (Date.now() - lastGen.getTime()) / 86_400_000;
  if (days >= REGEN_DAYS) triggers.push(`tiempo(${Math.floor(days)}d)`);

  // Visitas nuevas desde la última generación.
  const newVisits = visitCount - (user.content_last_visit_count || 0);
  if (newVisits >= MIN_NEW_VISITS) triggers.push(`visitas-nuevas(${newVisits})`);

  // Cambio masivo en productos.
  const sigNow = new Set(productSigs(products));
  const sigLast = new Set(safeParse(user.content_last_products_sig) || []);
  const changed = symmetricDiff(sigNow, sigLast);
  if (changed >= MIN_PRODUCT_CHANGES) triggers.push(`productos(${changed})`);

  // Cambio de nombre o de sector del emprendimiento.
  if ((user.business_name || '') !== (user.content_last_business_name || '')) {
    triggers.push('cambio-nombre');
  }
  if ((user.business_category || '') !== (user.content_last_business_category || '')) {
    triggers.push('cambio-sector');
  }

  return { should: triggers.length > 0, triggers };
}

/**
 * Resume productos + visitas recientes en un objeto compacto (menos tokens = menos costo).
 */
function summarize(products, visits) {
  const nat = {};
  const prod = {};
  let revenue = 0;
  let minD = null;
  let maxD = null;

  for (const v of visits) {
    if (v.nationality) nat[v.nationality] = (nat[v.nationality] || 0) + 1;
    revenue += Number(v.total_amount) || 0;
    const d = v.registration_date ? new Date(v.registration_date) : null;
    if (d && !isNaN(d.getTime())) {
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    }
    const sps = Array.isArray(v.selected_products) ? v.selected_products : [];
    for (const sp of sps) {
      const name = (sp && sp.name) || `#${sp && sp.id}`;
      prod[name] = (prod[name] || 0) + (Number(sp && sp.quantity) || 1);
    }
  }

  const topNat = Object.entries(nat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topProd = Object.entries(prod).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return {
    count: visits.length,
    revenue,
    topNat,
    topProd,
    range: minD && maxD ? `${minD.toISOString().slice(0, 10)} a ${maxD.toISOString().slice(0, 10)}` : 'n/d',
    products: products.map((p) => ({ name: p.name, category: p.category, price: p.base_price }))
  };
}

function buildPrompt(user, s) {
  const productList =
    s.products.map((p) => `- ${p.name} (${p.category || 's/categoría'}) S/${p.price}`).join('\n') ||
    '- (sin productos aún)';

  return `Eres un asistente para micro-emprendimientos de turismo en Perú (app "Yupay Turismo").
Analiza los datos del negocio y genera contenido útil y específico (no genérico).

NEGOCIO
- Nombre: ${user.business_name || 'N/D'}
- Sector/categoría: ${user.business_category || 'N/D'}

PRODUCTOS/SERVICIOS (${s.products.length})
${productList}

ACTIVIDAD RECIENTE
- Visitas analizadas: ${s.count}
- Ingresos: S/ ${s.revenue.toFixed(2)}
- Rango de fechas: ${s.range}
- Nacionalidades frecuentes: ${s.topNat.map(([n, c]) => `${n} (${c})`).join(', ') || 'n/d'}
- Productos más vendidos: ${s.topProd.map(([n, c]) => `${n} (${c})`).join(', ') || 'n/d'}

TAREA
Para CADA uno de los 4 idiomas (Español, Quechua/runasimi, Português, English) redacta DOS textos:
- "tip": 2 a 4 consejos prácticos y accionables para que el emprendedor venda más y mejore
  la atención, basados en los datos anteriores (nacionalidades frecuentes, productos top,
  estacionalidad, precios). Concreto, no obvio.
- "map": una breve guía turística para compartir con los visitantes: 3 a 5 atractivos o una
  ruta recomendada cerca del negocio, redactada de forma atractiva y acorde al perfil de
  turistas observado.

Cada texto debe estar redactado COMPLETAMENTE en el idioma de su clave
(espanol = Español, quechua = Runasimi, portugues = Português, ingles = English).

Devuelve ÚNICAMENTE este JSON, con los 8 textos llenos (sin dejar ninguno vacío):
{
  "espanol":   { "tip": "...", "map": "..." },
  "quechua":   { "tip": "...", "map": "..." },
  "portugues": { "tip": "...", "map": "..." },
  "ingles":    { "tip": "...", "map": "..." }
}`;
}

/**
 * Llama a la API de Gemini (generateContent) con salida estructurada (JSON).
 */
async function callGemini(user, products, recentVisits) {
  const s = summarize(products, recentVisits);
  const prompt = buildPrompt(user, s);

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192, // 8 textos pueden ser largos; evita truncamiento.
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Gemini HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini no devolvió texto (posible filtro de seguridad o cuota).');

  // El objeto anidado { espanol:{tip,map}, ... } se aplana a los 8 items.
  const parsed = JSON.parse(text);
  const items = [];
  for (const { key, label } of LANG_MAP) {
    const node = parsed[key] || {};
    items.push({ language: label, type: 'tip', content: node.tip || '' });
    items.push({ language: label, type: 'map', content: node.map || '' });
  }
  return items;
}

/**
 * Normaliza la salida de la IA a EXACTAMENTE 8 filas (rellena faltantes vacías).
 */
function buildRows(userId, items) {
  const map = new Map();
  for (const it of items) {
    if (it && it.language && it.type) {
      map.set(`${it.language}|${it.type}`, it.content || '');
    }
  }
  const now = new Date().toISOString();
  const rows = [];
  for (const language of LANGS) {
    for (const type of TYPES) {
      rows.push({
        user_id: userId,
        language,
        type,
        content: map.get(`${language}|${type}`) ?? '',
        audio_base64: null,
        last_modified: now
      });
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────
//  API pública del servicio
// ─────────────────────────────────────────────────────────────────

/**
 * Decide y (si corresponde) genera el contenido. Pensado para usarse
 * tanto en segundo plano como desde el endpoint manual.
 * @returns {Promise<object>} resumen de lo ocurrido.
 */
async function maybeGenerate(userId, { force = false, reason = 'desconocido' } = {}) {
  if (!supabaseAdmin) return { skipped: true, reason: 'sin-service-role' };
  if (!GEMINI_API_KEY) return { skipped: true, reason: 'sin-GEMINI_API_KEY' };
  if (inFlight.has(userId)) return { skipped: true, reason: 'generacion-en-curso' };

  inFlight.add(userId);
  try {
    // 1) Cargar estado actual.
    const { data: user } = await supabaseAdmin.from('users').select('*').eq('id', userId).maybeSingle();
    if (!user) return { skipped: true, reason: 'usuario-no-encontrado' };

    const { data: products } = await supabaseAdmin.from('products').select('*').eq('user_id', userId);
    const { count: visitCount } = await supabaseAdmin
      .from('visits')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // 2) Gating.
    const decision = evaluate(user, products || [], visitCount || 0, force);
    if (!decision.should) {
      return { skipped: true, reason: 'sin-disparadores', triggers: [] };
    }

    // 3) Visitas recientes para el prompt.
    const { data: recentVisits } = await supabaseAdmin
      .from('visits')
      .select('*')
      .eq('user_id', userId)
      .order('registration_date', { ascending: false })
      .limit(30);

    // 4) Llamar a la IA.
    const items = await callGemini(user, products || [], recentVisits || []);
    const rows = buildRows(userId, items);

    // 5) Upsert de las 8 filas (service_role: ignora RLS).
    const { error: upErr } = await supabaseAdmin
      .from('content')
      .upsert(rows, { onConflict: 'user_id,language,type' });
    if (upErr) throw new Error(`upsert content: ${upErr.message}`);

    // 6) Guardar metadatos para el próximo gating.
    await supabaseAdmin
      .from('users')
      .update({
        content_last_generated_at: new Date().toISOString(),
        content_last_visit_count: visitCount || 0,
        content_last_products_sig: JSON.stringify(productSigs(products || [])),
        content_last_business_name: user.business_name || null,
        content_last_business_category: user.business_category || null
      })
      .eq('id', userId);

    const nonEmpty = rows.filter((r) => r.content && r.content.trim()).length;
    if (nonEmpty < rows.length) {
      console.warn(`[CONTENT-GEN] aviso: ${rows.length - nonEmpty}/8 textos vinieron vacíos de la IA.`);
    }
    console.log(
      `[CONTENT-GEN] (${reason}) generado para ${userId}: ${nonEmpty}/${rows.length} con texto | ${decision.triggers.join(', ')}`
    );
    return { generated: true, count: rows.length, nonEmpty, triggers: decision.triggers, reason };
  } catch (err) {
    console.error(`[CONTENT-GEN] (${reason}) error para ${userId}:`, err.message);
    return { error: err.message, reason };
  } finally {
    inFlight.delete(userId);
  }
}

/**
 * Dispara la generación en SEGUNDO PLANO (no bloquea el request del usuario).
 */
function triggerBackground(userId, reason) {
  setImmediate(() => {
    maybeGenerate(userId, { reason }).catch((e) =>
      console.error('[CONTENT-GEN] background:', e && e.message)
    );
  });
}

/**
 * Solo inspecciona el gating (sin llamar a la IA). Para GET /content/status.
 */
async function inspect(userId) {
  if (!supabaseAdmin) return { error: 'sin-service-role' };
  const { data: user } = await supabaseAdmin.from('users').select('*').eq('id', userId).maybeSingle();
  if (!user) return { error: 'usuario-no-encontrado' };

  const { data: products } = await supabaseAdmin.from('products').select('*').eq('user_id', userId);
  const { count } = await supabaseAdmin
    .from('visits')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const decision = evaluate(user, products || [], count || 0, false);
  return {
    geminiConfigured: Boolean(GEMINI_API_KEY),
    lastGeneratedAt: user.content_last_generated_at || null,
    visitCount: count || 0,
    lastVisitCount: user.content_last_visit_count || 0,
    newVisits: (count || 0) - (user.content_last_visit_count || 0),
    productCount: (products || []).length,
    wouldRegenerate: decision.should,
    triggers: decision.triggers,
    thresholds: { minNewVisits: MIN_NEW_VISITS, minProductChanges: MIN_PRODUCT_CHANGES, regenDays: REGEN_DAYS }
  };
}

module.exports = { maybeGenerate, triggerBackground, inspect, LANGS, TYPES };
