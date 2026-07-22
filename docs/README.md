# Turnero Clínico

Sistema web responsivo para gestionar el flujo de pacientes de una clínica:
un administrador reparte "fichas" a los consultorios, y 6 vistas colaboran
en tiempo real sin que cada persona necesite una cuenta — el acceso a cada
vista se comparte por link (WhatsApp/correo).

Ver [`arquitectura.md`](./arquitectura.md) para el diseño técnico completo
(multi-tenant, seguridad, RLS, flujo de cada vista).

## Vistas del sistema

| Vista | Acceso | Qué hace |
|---|---|---|
| Administrador | Login con correo + contraseña (registro abierto) | Reparte fichas, comparte los 6 links, inicia jornada |
| Archivista | Link público | Ve todas las fichas del día, marca cuáles ya procesó |
| Enfermera | Link público | Turnero: ve en tiempo real a quién llama cada consultorio |
| Consultorio 1 / 2 / 3 / Dental | Link público (uno por consultorio) | Ve sus pacientes asignados, presiona "Llamado" |

## 1. Requisitos

- Cuenta gratuita en [Supabase](https://supabase.com)
- Cuenta en [Vercel](https://vercel.com) (hosting gratuito)

## 2. Configurar el proyecto Supabase

1. Crea un proyecto nuevo en Supabase (capa gratuita).
2. En **SQL Editor**, pega y ejecuta el contenido completo de
   [`../supabase-schema.sql`](../supabase-schema.sql). Es idempotente:
   se puede volver a correr sin duplicar nada.
3. En **Authentication → Providers**, habilita **Anonymous Sign-ins**
   (necesario para que las vistas públicas funcionen).
4. En **Authentication → Settings**, revisa el toggle **Confirm email**:
   actívalo si quieres verificar que el correo del admin es real, o
   desactívalo si prefieres un alta sin fricción (es una decisión de
   riesgo/UX, no técnica).
5. En **Project Settings → API**, copia el `Project URL` y el `anon public key`.

## 3. Configurar el frontend

Edita [`../supabase-client.js`](../supabase-client.js) y reemplaza:

```js
const SUPABASE_URL      = "https://TU_PROYECTO.supabase.co";
const SUPABASE_ANON_KEY = "TU_ANON_KEY_PUBLICA_AQUI";
```

con los valores reales del paso anterior.

## 4. Desarrollo local

No hay build step (HTML/CSS/JS plano). Para probar localmente:

```bash
npm install
npm run dev
```

o simplemente sirve la carpeta con cualquier servidor estático
(`python -m http.server`, extensión Live Server, etc.). Ojo: los links
`/v/<token>` necesitan que el servidor reescriba cualquier ruta hacia
`index.html` (como hace `vercel.json` en producción) — un servidor
estático simple como `python -m http.server` no lo hace y esas rutas
darán 404 en local; usa `npm run dev` (`vercel dev`) si quieres probarlas
antes de desplegar.

## 5. Desplegar a producción (Vercel)

```bash
npm run deploy
```

`vercel.json` ya reescribe cualquier ruta hacia `index.html`, así que las
URLs `/v/<token>` funcionan como rutas de la SPA.

## 6. Keep-alive de Supabase

Los proyectos gratuitos de Supabase se pausan tras varios días de
inactividad. El workflow [`../.github/workflows/supabase-keepalive.yml`](../.github/workflows/supabase-keepalive.yml)
hace ping cada 3 días. En el repo de GitHub, define los secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## 7. Uso diario

1. El administrador inicia sesión (o crea su cuenta la primera vez).
2. Comparte los 6 links una sola vez (por WhatsApp o correo) — no hace
   falta reenviarlos cada día, siguen funcionando hasta que se regeneren.
3. Cada consultorio, Archivista y Enfermería dejan su link abierto en su
   dispositivo (tablet, PC, o una pantalla/TV para el turnero).
4. El administrador reparte fichas conforme llegan los pacientes.
5. Al cerrar el día: "Iniciar jornada" limpia los registros para el día
   siguiente (los 6 links siguen funcionando sin cambios).
