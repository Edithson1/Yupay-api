-- ═══════════════════════════════════════════════════════════════════
--  Políticas RLS de ESCRITURA (INSERT/UPDATE/DELETE) por propietario.
--  Ejecutar en el SQL Editor de Supabase (una sola vez). Idempotente.
--
--  Motivo: realtime_setup.sql habilita RLS en products/visits/users pero solo
--  crea las políticas de SELECT (`*_select_own`). El CRUD incremental de la app
--  (POST/PUT/DELETE /products, /visits, PUT /users) usa el JWT del usuario
--  (req.supabase, con RLS), así que SIN políticas de escritura devuelve 4xx y el
--  outbox del cliente descarta el cambio en silencio (CloudSyncRepository:
--  classifyFail → DROP). Efecto: los productos/visitas creados o editados tras
--  el login no se suben. `/sync/migrate` no se ve afectado porque usa el cliente
--  service_role (supabaseAdmin), que salta RLS.
--
--  Nota: cada usuario solo puede escribir SUS propias filas (auth.uid() = user_id;
--  en users, auth.uid() = id). Mismo criterio que las políticas de SELECT.
-- ═══════════════════════════════════════════════════════════════════

do $$
begin
  -- ---------- products (owner = user_id) ----------
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='products' and policyname='products_insert_own') then
    create policy "products_insert_own" on public.products
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='products' and policyname='products_update_own') then
    create policy "products_update_own" on public.products
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='products' and policyname='products_delete_own') then
    create policy "products_delete_own" on public.products
      for delete using (auth.uid() = user_id);
  end if;

  -- ---------- visits (owner = user_id) ----------
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='visits' and policyname='visits_insert_own') then
    create policy "visits_insert_own" on public.visits
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='visits' and policyname='visits_update_own') then
    create policy "visits_update_own" on public.visits
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='visits' and policyname='visits_delete_own') then
    create policy "visits_delete_own" on public.visits
      for delete using (auth.uid() = user_id);
  end if;

  -- ---------- users (owner = id) ----------
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='users' and policyname='users_insert_own') then
    create policy "users_insert_own" on public.users
      for insert with check (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='users' and policyname='users_update_own') then
    create policy "users_update_own" on public.users
      for update using (auth.uid() = id) with check (auth.uid() = id);
  end if;
end$$;
