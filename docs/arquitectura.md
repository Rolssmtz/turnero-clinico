# Arquitectura — Turnero Clínico

## Resumen

SPA vanilla (HTML/CSS/JS, sin bundler) + Supabase (Postgres + Auth +
Realtime), desplegada en Vercel. Multi-tenant: cada administrador que se
registra es un "tenant" con sus datos 100% aislados, sobre un único
proyecto Supabase gratuito compartido.

## El problema central: vistas públicas, aisladas y en tiempo real

Los 6 links de vista (`/v/{share_token}`) deben cumplir tres cosas a la vez:

1. **Aislamiento por tenant** — un link de la Clínica A nunca debe exponer
   datos de la Clínica B.
2. **Tiempo real** — Enfermera y Archivista se actualizan sin refrescar.
3. **Seguridad real** — el `anon key` de Supabase es público (viaja en el
   JS del navegador), así que ninguna regla de acceso puede depender de
   "el cliente promete filtrar por tenant_id"; eso es evadible con un
   `fetch` directo a la API REST de Supabase.

### Solución: sesión anónima + tabla de mapeo + RLS

```
Usuario abre /v/{token}
        │
        ▼
 supabase.auth.signInAnonymously()   →  sesión real (auth.uid() existe)
        │
        ▼
 rpc('redeem_view_link', token)      →  valida el token contra view_links
        │                                e inserta/actualiza una fila en
        │                                anon_sessions (auth.uid() → tenant_id, view_type)
        ▼
 Toda política RLS de `fichas`/`llamados` consulta anon_sessions en vivo
 (vía la función anon_ctx()) para decidir qué filas son visibles.
```

**¿Por qué una tabla de mapeo y no "custom claims" en el JWT?**
Se evaluó inyectar `tenant_id`/`view_type` como claims del JWT vía un
Custom Access Token Hook de Supabase Auth, pero se descartó:

- Los claims quedan **congelados hasta el próximo refresh** (~1h) — revocar
  un link no tendría efecto inmediato.
- El hook es **global al proyecto**: corre para todo login, incluido el
  del administrador. Un error en el hook podría romper el login de admin.

Con la tabla `anon_sessions`, revocar acceso es un `DELETE` que surte
efecto en la siguiente consulta — no hay que esperar a que expire nada.

### Ninguna vista pública escribe directo en la tabla

Todas las escrituras desde una vista pública pasan por funciones
`SECURITY DEFINER` (`emitir_llamado`, `marcar_procesado`) que:

- Verifican `anon_ctx()` (a qué tenant/vista pertenece la sesión actual).
- Re-derivan los datos reales desde la fila (nunca confían en lo que
  mande el cliente), evitando que una vista falsifique un llamado con
  datos de otro paciente.

Esto también evita el problema de que Postgres RLS solo filtra **filas**,
no columnas — si Archivista tuviera un UPDATE directo sobre `fichas`,
técnicamente podría enviar un `UPDATE` con cualquier columna. Con el RPC
`marcar_procesado`, el único cambio posible es exactamente ese campo.

### Realtime

Supabase Realtime revalida las políticas RLS en cada cambio de fila usando
la conexión autenticada del cliente — por eso es indispensable la sesión
anónima (no hay Realtime seguro y aislado por tenant sin alguna sesión de
Supabase Auth detrás). Detalle operativo importante: hay que llamar
`supabaseClient.realtime.setAuth(access_token)` tras el login/redeem **y de
nuevo en cada evento `TOKEN_REFRESHED`** — si no, una tablet de consultorio
dejada abierta todo el día deja de recibir actualizaciones en silencio
cuando el JWT anónimo rota (implementado en `keepRealtimeAuthFresh()` en
`supabase-client.js`).

## Enrutamiento: administrador vs. vistas públicas

Contrato de enrutamiento (intencional, implementado en `boot()` en
`app.js` — ver comentarios ahí):

- **`/` es el único lugar de la app donde existen la vista de
  login/registro (`view-access`) y la vista de administrador
  (`view-admin`)**. Si hay una sesión de administrador válida (no
  anónima), se muestra `view-admin`; si no, `view-access`.
- **`/v/:token` siempre resuelve a su vista pública asignada**
  (Archivista, Enfermera, o el Consultorio correspondiente) o, si el
  token no es válido/está desactivado, a `view-link-error`. Esta ruta
  **nunca** muestra `view-access` ni `view-admin`, sin importar si ese
  mismo navegador tiene además una sesión de administrador activa en
  `/` — son dos flujos de arranque completamente separados
  (`bootstrapAdminApp()` vs. `bootstrapPublicView()`), cada uno con su
  propio cliente de Supabase (ver sesión anónima aislada por pestaña,
  abajo).
- **La única forma de volver a ver el login/registro en `/` es que el
  administrador cierre sesión explícitamente** (botón "Cerrar sesión"
  → `adminSignOut()` → evento `SIGNED_OUT` → `showView('view-access')`).
  No hay ningún otro camino (expiración de sesión, error de red, etc.)
  que muestre login/registro desde una vista pública.

### Sesión anónima aislada por pestaña

El cliente de Supabase se crea de forma diferida vía
`Turnero.initClient(mode)`, llamado una sola vez en `boot()` según la
ruta:

- `mode: 'admin'` (ruta `/`) → sesión persistida en `localStorage`
  (sobrevive a reinicios del navegador; el admin no quiere loguearse
  cada vez).
- `mode: 'public'` (ruta `/v/:token`) → sesión persistida en
  `sessionStorage`, **aislada por pestaña**. Se detectó en pruebas que,
  con `localStorage` (compartido entre pestañas del mismo origen), abrir
  varios links de vista en distintas pestañas del mismo navegador hacía
  que todas terminaran compartiendo una sola sesión anónima — cada
  `redeem_view_link` sobrescribía el mapeo tenant/vista de esa sesión
  compartida, y la última pestaña en canjear un link determinaba lo que
  veían TODAS (ej. la pestaña de Consultorio 1 llegó a mostrar fichas de
  Consultorio Dental). `sessionStorage` resuelve esto porque cada pestaña
  tiene su propio storage.

## Modelo de datos

| Tabla | Propósito |
|---|---|
| `profiles` | Un tenant = un administrador real (1:1 con `auth.users`) |
| `view_links` | Los 6 links compartibles por tenant (`share_token`, `active`) |
| `anon_sessions` | Mapeo sesión anónima → tenant/vista (única fuente de verdad para RLS pública) |
| `fichas` | Un registro por paciente/jornada, con su consultorio asignado |
| `llamados` | Log de cada "Llamado" (append-only), alimenta el turnero de Enfermería |

Ver el DDL completo y comentado en [`../supabase-schema.sql`](../supabase-schema.sql).

### Principio uniforme de RLS

- El **administrador** (`auth.uid() = tenant_id`) tiene CRUD completo sobre
  sus propios datos.
- Toda **sesión pública** (vista canjeada) solo **lee** vía policy, y solo
  **escribe** vía un RPC `SECURITY DEFINER` que valida `anon_ctx()`
  internamente.

### RPCs

- `redeem_view_link(token)` — único punto donde se valida un `share_token`.
- `emitir_llamado(ficha_id)` — Consultorio → inserta en `llamados`.
- `marcar_procesado(ficha_id, valor)` — Archivista → marca el checkbox.
- `iniciar_jornada()` — Admin → borra `fichas` + `llamados` del tenant.
  **No** borra `view_links` ni `anon_sessions`: los links y los
  dispositivos ya vinculados deben seguir funcionando al día siguiente.
- `regenerate_view_link(view_type)` — Admin → cambia el `share_token` y
  además borra las `anon_sessions` de esa vista, para que cualquier
  dispositivo con el link viejo pierda acceso de inmediato.

## Flujo de "Repartir fichas" → "Llamado" → Turnero

1. Admin registra una ficha (`INSERT` directo en `fichas`, admin-only).
2. Esa ficha aparece **en tiempo real** en Archivista (naranja, sin
   procesar) y en la vista del Consultorio asignado.
3. El Consultorio presiona "Llamado" → `emitir_llamado(ficha_id)` inserta
   en `llamados`.
4. Enfermería recibe el `INSERT` por Realtime y lo muestra de inmediato en
   el turnero (el más reciente resaltado, historial debajo).
5. Archivista marca el checkbox cuando procesa el expediente físico → fila
   cambia a verde. Esto es bookkeeping administrativo independiente del
   flujo de llamado (no bloquea que el consultorio siga llamando).

## Notas de despliegue en Vercel (bugs reales encontrados y corregidos)

Al probar el despliegue real se encontraron dos problemas de plataforma
no evidentes en local, ambos ya corregidos en el código actual:

1. **`cleanUrls: true` + rewrite catch-all rompe el ruteo.** Con
   `cleanUrls` activo, Vercel devolvía 404 de plataforma para cualquier
   ruta que no fuera la raíz exacta (nunca llegaba a `index.html`, ni
   siquiera para rutas inventadas). Fix: `vercel.json` solo tiene
   `rewrites`, sin `cleanUrls`/`trailingSlash`.
2. **Rutas relativas de assets mal resueltas en subrutas.** Con el
   rewrite ya funcionando, `index.html` se servía correctamente en
   `/v/<token>`, pero `<script src="app.js">`/`<link href="styles.css">`
   (rutas relativas) se resolvían contra `/v/<token>` en vez de la raíz
   (pedían `/v/app.js`), y el propio rewrite catch-all también atrapaba
   esas rutas mal formadas, devolviendo el HTML de `index.html` en vez
   del JS/CSS real — la app se quedaba colgada en "Cargando…". Fix:
   `<base href="/">` en el `<head>` de `index.html`.

Ambos se detectaron probando con `curl`/DevTools contra la URL de
producción real, no solo en local — recomendable repetir ese tipo de
prueba tras cualquier cambio a `vercel.json` o a las rutas del `<head>`.

## Estructura de archivos

```
turnero-clinico/
├── index.html                  # las 7 <section id="view-*">
├── styles.css                  # design tokens + estilos de cada vista
├── supabase-client.js          # capa de adaptación a Supabase (auth, CRUD, realtime)
├── app.js                      # routing + lógica de UI de cada vista
├── supabase-schema.sql         # DDL completo (tablas, RLS, RPCs), idempotente
├── vercel.json                 # rewrite catch-all → index.html (SPA sin bundler)
├── package.json                # sin bundler, scripts de vercel dev/deploy
├── .github/workflows/          # keep-alive de Supabase
└── docs/                       # este documento + guía de instalación
```
