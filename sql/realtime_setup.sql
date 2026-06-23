-- ═══════════════════════════════════════════════════════════════════
--  Supabase Realtime — sync online instantáneo ("campana" que dispara el pull)
--  Ejecutar en el SQL Editor de Supabase (una sola vez).
--
--  La app se suscribe por WebSocket a los cambios de estas tablas filtrados por
--  su user_id; al llegar un evento dispara /sync/pull incremental (no aplica el
--  payload del socket directamente). Realtime autoriza la suscripción usando la
--  política RLS de SELECT del usuario.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Añadir las tablas a la publicación de Realtime (idempotente).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='visits') then
    alter publication supabase_realtime add table public.visits;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='products') then
    alter publication supabase_realtime add table public.products;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='content') then
    alter publication supabase_realtime add table public.content;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='users') then
    alter publication supabase_realtime add table public.users;
  end if;
end$$;

-- 2) REPLICA IDENTITY FULL: necesario para que los filtros (user_id=eq...) y los
--    eventos UPDATE/DELETE incluyan los datos completos de la fila.
alter table public.visits   replica identity full;
alter table public.products replica identity full;
alter table public.content  replica identity full;
alter table public.users    replica identity full;

-- 3) RLS + política SELECT por propietario en las 4 tablas (Realtime la usa para
--    autorizar la suscripción). content ya tiene content_select_own.
alter table public.visits   enable row level security;
alter table public.products enable row level security;
alter table public.users    enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='visits' and policyname='visits_select_own') then
    create policy "visits_select_own" on public.visits for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='products' and policyname='products_select_own') then
    create policy "products_select_own" on public.products for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='users' and policyname='users_select_own') then
    create policy "users_select_own" on public.users for select using (auth.uid() = id);
  end if;
end$$;
