-- ═══════════════════════════════════════════════════════════════════
--  products.last_modified — necesaria para migrate, el CRUD y el /sync/pull
--  Ejecutar en el SQL Editor de Supabase (una sola vez). Idempotente.
--
--  Motivo: TODA escritura de producto sella `last_modified`
--  (syncController.mapProductRow, productsController.mapProductIn) y el pull
--  incremental filtra por `last_modified > since` (syncController.pull). Si la
--  columna no existe en la BD desplegada, `POST /sync/migrate` falla en el paso
--  "products (insert)" y hace rollback → los productos del emprendedor NO se
--  guardan al registrarse (aunque el perfil sí, porque lo graba /auth/register).
--  Análoga a visits_last_modified.sql.
--
--  Ejecutar ANTES de (re)desplegar la API.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Columna last_modified (default para filas nuevas).
alter table public.products
  add column if not exists last_modified timestamptz default now();

-- 2) Backfill de filas existentes (created_at como mejor aproximación).
update public.products
   set last_modified = coalesce(last_modified, created_at, now())
 where last_modified is null;

-- 3) Trigger que sella last_modified = now() en cada INSERT/UPDATE.
--    Más robusto que setearlo en la API: cubre cualquier vía de escritura.
create or replace function public.set_products_last_modified()
returns trigger as $$
begin
  new.last_modified := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_last_modified on public.products;
create trigger trg_products_last_modified
  before insert or update on public.products
  for each row execute function public.set_products_last_modified();

-- 4) Índice para el filtro incremental del pull.
create index if not exists products_user_lastmod_idx
  on public.products (user_id, last_modified);
