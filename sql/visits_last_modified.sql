-- ═══════════════════════════════════════════════════════════════════
--  visits.last_modified — sync incremental de ediciones y estado de visitas
--  Ejecutar en el SQL Editor de Supabase (una sola vez).
--
--  Motivo: /sync/pull filtraba visitas por registration_date, que NUNCA cambia
--  tras crearse. Por eso las ediciones y el cambio de estado is_sent de una
--  visita ya existente no se propagaban a otros dispositivos (solo llegaban
--  visitas nuevas). Con last_modified el pull de visitas se comporta igual que
--  el de products/content.
--
--  Ejecutar ANTES de desplegar la API que filtra por last_modified.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Columna last_modified (default para filas nuevas).
alter table public.visits
  add column if not exists last_modified timestamptz default now();

-- 2) Backfill de filas existentes (registration_date como mejor aproximación).
update public.visits
   set last_modified = coalesce(last_modified, registration_date, now())
 where last_modified is null;

-- 3) Trigger que sella last_modified = now() en cada INSERT/UPDATE.
--    Más robusto que setearlo en la API: cubre cualquier vía de escritura.
create or replace function public.set_visits_last_modified()
returns trigger as $$
begin
  new.last_modified := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_visits_last_modified on public.visits;
create trigger trg_visits_last_modified
  before insert or update on public.visits
  for each row execute function public.set_visits_last_modified();

-- 4) Índice para el filtro incremental del pull.
create index if not exists visits_user_lastmod_idx
  on public.visits (user_id, last_modified);
