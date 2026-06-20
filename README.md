# Yupay Turismo — API REST

API REST en **Node.js + Express** sobre **Supabase** (Auth + PostgREST con RLS).

## Requisitos
- Node.js >= 18 (usa `fetch` global y `node --watch`).
- Un proyecto de Supabase con el schema ya creado y RLS activo.

## Configuración

1. Copia `.env.example` a `.env` y rellena tus claves:

```
SUPABASE_URL=https://vckyqnwhlieulepnetqa.supabase.co
SUPABASE_ANON_KEY=<tu anon key>
SUPABASE_SERVICE_ROLE_KEY=<tu service role key>   # solo lo usa /sync/migrate
PORT=3000
```

> El `.env` está en `.gitignore` y nunca debe subirse. La `service_role key` es
> secreta: solo vive en el servidor.

## Cómo correr el proyecto

```bash
npm install && npm start
```

Para desarrollo con recarga automática:

```bash
npm run dev
```

La API queda en `http://localhost:3000`. Healthcheck: `GET /health`.

## Despliegue en Render

Este repositorio **es** la API (el `package.json` está en la raíz) e incluye un **Blueprint**
(`render.yaml` en la raíz, sin `rootDir`):

1. Sube el repo a GitHub/GitLab.
2. En Render: **New + → Blueprint** y selecciona el repo (detecta `render.yaml`).
3. En **Environment** del servicio, rellena los secretos (no se versionan):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` y,
   opcionalmente, `GOOGLE_WEB_CLIENT_ID` / `GOOGLE_ANDROID_CLIENT_ID` (Google nativo).
4. Render ejecuta `npm install` y `npm start`, comprueba `GET /health` y publica la URL
   `https://<servicio>.onrender.com` (ese es el `baseUrl` para la app y la consola web).

Notas:
- **No** definas `PORT`: Render lo inyecta y el server ya escucha en `process.env.PORT` y `0.0.0.0`.
- El plan **free** se suspende por inactividad (cold start en la primera petición).
- `CORS` está abierto (`*`), así que la consola web de pruebas puede apuntar a la URL pública.

## Autenticación

Todos los endpoints (salvo `/auth/config`, `/auth/register`, `/auth/login`,
`/auth/google`, `/auth/google/idtoken`, `/auth/refresh`, `/auth/check-email`,
`/auth/resend-verification`, `/auth/forgot-password`, `/auth/verify-reset-code`,
`/auth/reset-password` y `/health`) requieren el header:

```
Authorization: Bearer <accessToken>
```

El `accessToken` y el `refreshToken` se obtienen de `/auth/login`, `/auth/register`
o `/auth/google`.

### Autenticación con Google (OAuth gestionado por Supabase)

Google se configura **por completo en Supabase**; la API ya **no** guarda ningún
`GOOGLE_CLIENT_ID` ni llama a `signInWithIdToken`. El flujo es:

1. El **cliente** (la web de pruebas, o la app) crea un cliente Supabase en el navegador
   con la `supabaseUrl` + `supabaseAnonKey` (las expone `GET /auth/config`) y llama a
   `supabase.auth.signInWithOAuth({ provider: 'google' })`.
2. Supabase redirige a Google y vuelve a la página del cliente con una **sesión**
   (`access_token` + `refresh_token`).
3. El cliente manda ese `accessToken` a `POST /auth/google`. La API lo **verifica** con
   `supabase.auth.getUser(accessToken)`, crea la fila de perfil si es la primera vez, y
   registra/actualiza el dispositivo.

Un solo endpoint cubre **ambos** casos de uso:

- **Registro con Google**: primer ingreso → crea el usuario y su fila de perfil.
- **Login con Google**: ingresos siguientes → solo sincroniza.
- **Login con Google independiente del registro**: si el usuario ya existía con
  email/contraseña y el correo es el **mismo Gmail verificado**, Supabase enlaza la
  identidad de Google al mismo usuario (enlazado automático por email verificado, que es
  el comportamiento por defecto de Supabase).

Body:

```json
{
  "accessToken": "<access_token de la sesión de Supabase tras el login con Google>",
  "refreshToken": "<opcional; se guarda hasheado en el dispositivo>",
  "hardwareDeviceId": "...",
  "deviceName": "...",
  "businessName": "opcional",
  "businessCategory": "opcional"
}
```

Respuesta: `{ success, data: { user, session, isNewUser } }` (mismo formato de sesión que
`/auth/login`). `isNewUser` indica si fue un registro (`true`) o un login (`false`).

#### Configuración necesaria (una sola vez, solo en Supabase)

1. **Google Cloud Console** → *APIs & Services → Credentials* → crea un **OAuth client ID**
   de tipo **Web application**. En *Authorized redirect URIs* añade la URL de callback de
   Supabase: `https://<tu-proyecto>.supabase.co/auth/v1/callback`.
2. **Supabase** → *Authentication → Providers → Google*: habilítalo y pega el **Client ID**
   y el **Client Secret** de Google.
3. **Supabase** → *Authentication → URL Configuration → Redirect URLs*: añade el origen
   desde el que sirves el cliente/web (p.ej. `http://localhost:5500`,
   `http://localhost:3000`) para que Supabase pueda redirigir de vuelta tras el login.
4. **API**: nada que configurar. Ya no hace falta `GOOGLE_CLIENT_ID` en el `.env`.

> Si el proveedor no está habilitado en Supabase, `signInWithOAuth` falla con
> `Provider (issuer "https://accounts.google.com") is not enabled`, y `/auth/google`
> responde **401** si el `accessToken` no es válido.

### Google nativo en Android (`POST /auth/google/idtoken`)

Para la app Android (Credential Manager / One Tap, sin navegador): la app obtiene un
`idToken` de Google y lo manda a `POST /auth/google/idtoken`; la API lo canjea con
`signInWithIdToken` y devuelve una sesión real de Supabase (`accessToken` + `refreshToken`)
más `isNewUser`. Body: `{ idToken, nonce?, hardwareDeviceId?, deviceName?, businessName?, businessCategory? }`.

**Sobre el límite de "un solo Client ID" en Supabase:** el campo principal *Client ID* del
provider Google guarda **uno** (el **Web**), pero el campo **"Authorized Client IDs"** admite
**varios separados por coma** — ahí van el Client ID **Web** y el de **Android**. La app debe
usar el **Client ID Web** como `serverClientId` de Credential Manager (el de Android solo
autoriza la app por *package + SHA-1*).

Variables **opcionales** del `.env` (`GOOGLE_WEB_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID`):
- se exponen en `GET /auth/config` (`googleWebClientId`, `googleAndroidClientId`) para que la
  app sepa qué `serverClientId` usar;
- si están definidas, la API **pre-valida** el `aud` del `idToken` y devuelve un error claro
  si el token vino de un Client ID desconocido (la verificación criptográfica real la hace
  Supabase). Si se dejan vacías, todo sigue funcionando.

### Recuperación de contraseña por código de 6 dígitos (OTP)

El flujo **no usa enlaces de redirección**, sino un **código de 6 dígitos**:

1. `POST /auth/forgot-password` `{ email }` → envía el código **solo si** el correo está
   registrado **y tiene contraseña** (identidad `email`). Respuesta `200`:
   - `{ sent: true, reason: 'sent', message }` → código enviado.
   - `{ sent: false, reason: 'not_registered', message }` → no hay cuenta con ese correo.
   - `{ sent: false, reason: 'oauth_only', message }` → cuenta de solo-Google (sin contraseña).
2. `POST /auth/verify-reset-code` `{ email, code }` → valida el código. Si es correcto,
   `{ valid: true, session: { accessToken, refreshToken, … }, user }`. El código es de **un
   solo uso**: por eso se devuelve el `accessToken` de recuperación para el paso 3.
3. `POST /auth/reset-password` → cambia la contraseña, de dos formas:
   - `{ accessToken, newPassword }` (el token del paso 2, recomendado), o
   - `{ email, code, newPassword }` (atajo de un paso que valida el código aquí mismo).

> **Configuración en Supabase:** para que el correo traiga el **código** (y no un enlace),
> edita *Authentication → Email Templates → "Reset Password"* e incluye `{{ .Token }}`. La
> **longitud** del código (6 por defecto) se ajusta en *Authentication → "Email OTP Length"*;
> la API acepta cualquier longitud (la valida Supabase). `forgot-password`, `verify-reset-code`
> y `reset-password` requieren `SUPABASE_SERVICE_ROLE_KEY`.

## Formato de respuestas

- Éxito: `{ "success": true, "data": { ... } }`
- Error:  `{ "success": false, "error": "mensaje" }`

Los campos van en **camelCase** en requests y responses; internamente se traducen
a snake_case para Supabase.

## Endpoints

| Método | Ruta              | Auth | Descripción |
|--------|-------------------|------|-------------|
| GET    | /auth/config      | No   | Config no sensible para clientes (supabaseUrl/anonKey, métodos activos) |
| POST   | /auth/register    | No   | Alta de usuario + perfil + dispositivo |
| POST   | /auth/login       | No   | Login + alta/actualización de dispositivo |
| POST   | /auth/google      | No   | Sincroniza perfil/dispositivo tras login con Google web (OAuth de Supabase; `accessToken`) |
| POST   | /auth/google/idtoken | No | Login/registro con Google **nativo** (Android): `idToken` → `signInWithIdToken` |
| POST   | /auth/refresh     | No   | Refresca la sesión |
| POST   | /auth/check-email | No   | `{ email }` → `{ exists, confirmed }` (evitar repetir / detectar no registrado) |
| POST   | /auth/resend-verification | No | Reenvía el correo de verificación de registro |
| POST   | /auth/forgot-password | No | Envía un **código de 6 dígitos** (OTP) si el correo tiene contraseña |
| POST   | /auth/verify-reset-code | No | Valida el código de recuperación → token de recuperación |
| POST   | /auth/reset-password  | No | Cambia la contraseña (token de `verify`, o `email + code`) |
| POST   | /auth/logout      | Sí   | Revoca la sesión |
| DELETE | /auth/account     | Sí   | Elimina la cuenta y TODOS sus datos (content, visits, products, devices, perfil) |
| GET    | /users/me         | Sí   | Perfil del usuario |
| PATCH  | /users/me         | Sí   | Actualiza perfil (parcial) |
| GET    | /devices          | Sí   | Lista dispositivos |
| DELETE | /devices/:id      | Sí   | Elimina un dispositivo |
| GET    | /products         | Sí   | Lista productos |
| POST   | /products         | Sí   | Crea producto |
| PUT    | /products/:id     | Sí   | Actualiza producto |
| DELETE | /products/:id     | Sí   | Elimina producto |
| GET    | /visits           | Sí   | Lista visitas (paginado) |
| POST   | /visits           | Sí   | Crea visita |
| GET    | /visits/:id       | Sí   | Detalle de visita |
| PUT    | /visits/:id       | Sí   | Actualiza visita |
| DELETE | /visits/:id       | Sí   | Elimina visita |
| GET    | /content          | Sí   | Lista contenido |
| PUT    | /content          | Sí   | Upsert de contenido |
| GET    | /content/status   | Sí   | ¿Toca regenerar contenido con IA? (no gasta cuota) |
| POST   | /content/generate | Sí   | Genera contenido (map+tip x4 idiomas) con IA. `?force=true` ignora el gating |
| POST   | /sync/migrate     | Sí   | Migración inicial en batch |
| POST   | /sync/push        | Sí   | Sube cambios locales |
| GET    | /sync/pull        | Sí   | Descarga cambios desde `?since=` |

### GET /visits (paginación)
`?page=1&limit=20&from=<ms|ISO>&to=<ms|ISO>` → `{ items, page, limit, total, totalPages }`.

### GET /sync/pull
`?since=<ISO>` filtra `products`/`content` por `last_modified > since` y `visits`
por `registration_date > since`. Sin `since` devuelve todo.

## Generación de `content` con IA (Gemini)

El contenido (`map` y `tip` en **4 idiomas** → 8 registros por usuario) se **genera en el
servidor con Gemini** a partir de los productos y las visitas recientes del usuario.

**Disparo automático (en segundo plano, no bloquea la respuesta):** tras `POST /sync/migrate`
(primera subida), `POST /sync/push`, crear visita, crear/editar/borrar producto, `PUT /content`
y cambiar nombre/sector en `PATCH /users/me`.

**Gating de costos** (`src/services/contentGenerator.js`): solo se llama a Gemini si, desde la
última generación, se cumple **al menos una** condición:

- primera generación (nunca se generó);
- `≥ CONTENT_MIN_NEW_VISITS` visitas nuevas (def. 10);
- pasaron `≥ CONTENT_REGEN_DAYS` días (def. 30 ≈ 1 mes);
- cambio masivo en productos (`≥ CONTENT_MIN_PRODUCT_CHANGES` altas/bajas/ediciones, def. 3);
- cambió el **nombre** del emprendimiento;
- cambió el **sector/categoría** del emprendimiento.

Los metadatos de la última generación se guardan en columnas de `users`
(`content_last_*`). Ejecuta `sql/content_generation.sql` en Supabase para crearlas
(y la constraint `UNIQUE (user_id, language, type)` + política RLS de lectura).

**Configuración** (`.env`): `GEMINI_API_KEY` (secreta), `GEMINI_MODEL` (def.
`gemini-2.5-flash-lite`; alternativa de mayor calidad: `gemini-2.5-flash`),
`CONTENT_MIN_NEW_VISITS`, `CONTENT_MIN_PRODUCT_CHANGES`, `CONTENT_REGEN_DAYS`. Si falta
`GEMINI_API_KEY`, la API funciona igual pero **no** genera contenido (se registra un aviso
en consola).

> La IA devuelve **un único JSON** con los 8 textos (4 idiomas × {tip, map}) en una sola
> petición; el esquema marca todos los campos como obligatorios, así que siempre llegan los 8
> llenos. Si tu cuenta da `429 (limit:0)` en un modelo, prueba otro vía `GEMINI_MODEL`.

> La generación corre en segundo plano: tras una subida, el contenido aparece unos segundos
> después. Para verlo de inmediato (o probar), usa `POST /content/generate?force=true`, que
> genera de forma síncrona y devuelve el resumen.

## Notas de diseño

- **Dos clientes Supabase** (`src/config/supabase.js`): `anon` para auth y un cliente
  *por petición* con el JWT del usuario para que **RLS** aplique (`auth.uid()`).
  El cliente `service_role` solo se usa en `/sync/migrate`.
- **Fechas**: `registrationDate` llega como Long (ms) desde Android y se convierte con
  `new Date(ms).toISOString()` antes de insertar.
- **JSONB** (`selected_products`): se guarda y se devuelve tal cual (sus claves internas
  no se transforman).
- **Imágenes/audio**: `profile_picture` y `audio_base64` se guardan como base64 en TEXT
  (límite de body de 50 MB).

## Atomicidad real en `/sync/migrate` (opcional)

`@supabase/supabase-js` no expone transacciones multi-sentencia, así que la migración
usa un **rollback de mejor esfuerzo** (borra lo insertado si un paso falla). Para
atomicidad real (todo o nada en una sola transacción), crea una función Postgres y
llámala con `supabaseAdmin.rpc('sync_migrate', {...})`:

```sql
create or replace function public.sync_migrate(
  p_user_id uuid,
  p_profile jsonb,
  p_products jsonb,
  p_visits jsonb,
  p_content jsonb
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_products int := 0;
  v_visits int := 0;
  v_content int := 0;
begin
  -- Todo lo de abajo corre en una única transacción: si algo falla, se revierte todo.
  if p_profile is not null then
    insert into public.users (id, business_name, business_category, profile_picture)
    values (p_user_id,
            p_profile->>'businessName',
            p_profile->>'businessCategory',
            p_profile->>'profilePicture')
    on conflict (id) do update
      set business_name = excluded.business_name,
          business_category = excluded.business_category,
          profile_picture = excluded.profile_picture;
  end if;

  -- ... insertar products, visits (convertir registrationDate ms->timestamptz),
  --     y upsert de content; acumular contadores ...

  return jsonb_build_object('products', v_products, 'visits', v_visits, 'content', v_content);
end;
$$;
```

## Requisitos del schema para upserts

- `content`: índice/constraint **UNIQUE (user_id, language, type)** para el upsert.
- `products`: PK en `id` (ya existe por ser BIGSERIAL) para el upsert por id en `/sync/push`.
- Las columnas `last_modified` se setean desde la API en cada escritura para que
  `/sync/pull` funcione (también puedes usar un trigger `BEFORE UPDATE`).
