-- ============================================================================
-- Tombstones de borrado (propagación de borrados entre dispositivos)
-- ----------------------------------------------------------------------------
-- El /sync/pull incremental solo devuelve filas vivas, así que un dispositivo
-- nunca se enteraba de que OTRO dispositivo borró un producto/visita (la fila
-- "fantasma" se quedaba para siempre). Esta tabla registra cada borrado; el
-- pull devuelve los borrados ocurridos después de `since` y el cliente los
-- aplica localmente (deleteByRemoteId).
--
-- Ejecutar UNA vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

create table if not exists public.deletions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('product', 'visit')),
  remote_id   bigint not null,
  deleted_at  timestamptz not null default now()
);

-- Para filtrar por `deleted_at > since` de forma eficiente.
create index if not exists deletions_user_time_idx
  on public.deletions (user_id, deleted_at);

-- Evita tombstones duplicados (borrar dos veces el mismo id es idempotente).
create unique index if not exists deletions_user_entity_uidx
  on public.deletions (user_id, entity_type, remote_id);

-- RLS: cada usuario solo ve y registra SUS propios borrados.
alter table public.deletions enable row level security;

drop policy if exists deletions_select_own on public.deletions;
create policy deletions_select_own on public.deletions
  for select using (auth.uid() = user_id);

drop policy if exists deletions_insert_own on public.deletions;
create policy deletions_insert_own on public.deletions
  for insert with check (auth.uid() = user_id);
