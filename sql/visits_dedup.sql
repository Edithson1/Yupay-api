-- ═══════════════════════════════════════════════════════════════════
--  Deduplicación de visitas — unicidad por (user_id, registration_date)
--  Ejecutar en el SQL Editor de Supabase (una sola vez).
--
--  Motivo: POST /visits hacía INSERT ciego; si dos dispositivos de la misma
--  cuenta subían la misma visita (compartida por P2P), se duplicaba en la nube.
--  Este índice único lo hace imposible a nivel de datos. La API además se vuelve
--  idempotente (devuelve la fila existente en vez de insertar).
--
--  IMPORTANTE: el paso 1 BORRA duplicados preexistentes y conserva el de MENOR
--  id por grupo. Revisa/respalda antes si necesitas otro criterio.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Limpieza previa: elimina duplicados conservando la fila de menor id.
delete from public.visits v
 using public.visits dup
 where v.user_id = dup.user_id
   and v.registration_date = dup.registration_date
   and v.id > dup.id;

-- 2) Índice único: una sola visita por (user_id, registration_date).
create unique index if not exists visits_user_regdate_unique
  on public.visits (user_id, registration_date);
