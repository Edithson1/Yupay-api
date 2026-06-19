-- ═══════════════════════════════════════════════════════════════════
--  Generación de "content" con IA — requisitos de esquema
--  Ejecutar en el SQL Editor de Supabase (una sola vez).
-- ═══════════════════════════════════════════════════════════════════

-- 1) Constraint que exige el upsert de content (por si aún no existe).
--    Sin esto, /content (PUT) y la generación con IA fallan con code 42P10.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'content_user_lang_type_unique'
  ) then
    alter table public.content
      add constraint content_user_lang_type_unique unique (user_id, language, type);
  end if;
end$$;

-- 2) Metadatos de la última generación (en la tabla users) para el gating de costos.
alter table public.users
  add column if not exists content_last_generated_at      timestamptz,
  add column if not exists content_last_visit_count        integer default 0,
  add column if not exists content_last_products_sig       text,
  add column if not exists content_last_business_name      text,
  add column if not exists content_last_business_category  text;

-- 3) El usuario debe poder LEER su propio content (la IA lo escribe con service_role,
--    pero la app lo lee con el JWT del usuario bajo RLS). Asegura la política de SELECT.
alter table public.content enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'content' and policyname = 'content_select_own'
  ) then
    create policy "content_select_own" on public.content
      for select using (auth.uid() = user_id);
  end if;
end$$;
