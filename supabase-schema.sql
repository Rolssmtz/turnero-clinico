-- ════════════════════════════════════════════════════════════════
-- Turnero Clínico — Esquema Supabase (Postgres)
-- Multi-tenant: cada administrador (auth.users real) es un tenant
-- aislado. Las 6 vistas públicas (sin login) acceden vía links con
-- token, canjeados por una sesión anónima de Supabase Auth.
--
-- Script idempotente: se puede volver a correr sin duplicar objetos.
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ════════════════════════════════════════════════════════════════
-- 1. ENUM de vistas
-- ════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_type where typname = 'view_type') then
    create type public.view_type as enum (
      'archivista',
      'enfermera',
      'consultorio_1',
      'consultorio_2',
      'consultorio_3',
      'consultorio_dental'
    );
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════
-- 2. profiles — el tenant (una fila por administrador real)
-- ════════════════════════════════════════════════════════════════
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  clinic_name text,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: self select" on public.profiles;
create policy "profiles: self select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles: self update" on public.profiles;
create policy "profiles: self update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ════════════════════════════════════════════════════════════════
-- 3. view_links — los 6 links compartibles por tenant
-- ════════════════════════════════════════════════════════════════
create table if not exists public.view_links (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.profiles(id) on delete cascade,
  view_type   public.view_type not null,
  share_token uuid not null default gen_random_uuid(),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, view_type),
  unique (share_token)
);

alter table public.view_links enable row level security;

drop policy if exists "view_links: owner select" on public.view_links;
create policy "view_links: owner select" on public.view_links
  for select using (auth.uid() = tenant_id);

drop policy if exists "view_links: owner update" on public.view_links;
create policy "view_links: owner update" on public.view_links
  for update using (auth.uid() = tenant_id) with check (auth.uid() = tenant_id);

-- Sin policy de SELECT/INSERT/UPDATE para el rol público: el share_token
-- se valida SOLO dentro del RPC redeem_view_link (security definer).
-- Así el token nunca es legible por una consulta REST directa a la tabla.

-- ════════════════════════════════════════════════════════════════
-- 4. anon_sessions — mapeo sesión anónima → tenant/vista.
--    Único punto de verdad que consultan las políticas RLS de
--    fichas/llamados. Borrar una fila aquí revoca el acceso al
--    instante (no depende de la expiración de un JWT).
-- ════════════════════════════════════════════════════════════════
create table if not exists public.anon_sessions (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  tenant_id    uuid not null references public.profiles(id) on delete cascade,
  view_type    public.view_type not null,
  view_link_id uuid not null references public.view_links(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.anon_sessions enable row level security;

drop policy if exists "anon_sessions: self select" on public.anon_sessions;
create policy "anon_sessions: self select" on public.anon_sessions
  for select using (auth.uid() = user_id);

-- Sin INSERT/UPDATE directo: solo vía redeem_view_link (security definer).

-- Helper reutilizado en todas las políticas de fichas/llamados.
-- security definer + search_path fijo para poder leer anon_sessions
-- sin depender de que el rol que llama tenga permisos directos.
create or replace function public.anon_ctx()
returns table (tenant_id uuid, view_type public.view_type)
language sql
security definer
stable
set search_path = public
as $$
  select tenant_id, view_type from public.anon_sessions where user_id = auth.uid();
$$;

revoke all on function public.anon_ctx() from public;
grant execute on function public.anon_ctx() to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 5. Trigger: alta de administrador → crea profile + sus 6 view_links.
--    Ignora altas de usuarios anónimos (signInAnonymously) para no
--    interferir con el flujo de vistas públicas.
-- ════════════════════════════════════════════════════════════════
create or replace function public.handle_new_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  vt public.view_type;
begin
  if coalesce(new.is_anonymous, false) is true then
    return new;
  end if;

  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  foreach vt in array enum_range(null::public.view_type) loop
    insert into public.view_links (tenant_id, view_type, share_token)
    values (new.id, vt, gen_random_uuid())
    on conflict (tenant_id, view_type) do nothing;
  end loop;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_admin();

-- ════════════════════════════════════════════════════════════════
-- 6. fichas — un registro por paciente/jornada
-- ════════════════════════════════════════════════════════════════
create table if not exists public.fichas (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.profiles(id) on delete cascade,
  nombre_paciente         text not null,
  expediente              text not null,
  numero_ficha            text not null,
  consultorio             public.view_type not null
    check (consultorio in ('consultorio_1','consultorio_2','consultorio_3','consultorio_dental')),
  processed_by_archivista boolean not null default false,
  created_at              timestamptz not null default now(),
  unique (tenant_id, numero_ficha)
);

create index if not exists fichas_tenant_created_idx on public.fichas (tenant_id, created_at desc);
create index if not exists fichas_tenant_consultorio_idx on public.fichas (tenant_id, consultorio);

alter table public.fichas enable row level security;

-- El admin (usuario real autenticado) tiene control total sobre lo suyo.
drop policy if exists "fichas: admin all" on public.fichas;
create policy "fichas: admin all" on public.fichas
  for all using (auth.uid() = tenant_id) with check (auth.uid() = tenant_id);

-- Archivista: solo lectura de todas las fichas del tenant (la escritura
-- del checkbox "procesado" pasa por el RPC marcar_procesado, no por UPDATE
-- directo — evita que una fila de RLS permita tocar columnas no deseadas).
drop policy if exists "fichas: archivista select" on public.fichas;
create policy "fichas: archivista select" on public.fichas
  for select using (
    exists (select 1 from public.anon_ctx() c
            where c.view_type = 'archivista' and c.tenant_id = fichas.tenant_id)
  );

-- Consultorio: solo lectura de sus propias fichas asignadas.
drop policy if exists "fichas: consultorio select own" on public.fichas;
create policy "fichas: consultorio select own" on public.fichas
  for select using (
    exists (select 1 from public.anon_ctx() c
            where c.view_type = fichas.consultorio and c.tenant_id = fichas.tenant_id)
  );

-- ════════════════════════════════════════════════════════════════
-- 7. llamados — log de "Llamado" (append-only), alimenta el turnero
-- ════════════════════════════════════════════════════════════════
create table if not exists public.llamados (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.profiles(id) on delete cascade,
  ficha_id        uuid not null references public.fichas(id) on delete cascade,
  consultorio     public.view_type not null
    check (consultorio in ('consultorio_1','consultorio_2','consultorio_3','consultorio_dental')),
  numero_ficha    text not null,
  nombre_paciente text not null,
  called_at       timestamptz not null default now()
);

create index if not exists llamados_tenant_called_idx on public.llamados (tenant_id, called_at desc);
create index if not exists llamados_ficha_idx on public.llamados (ficha_id, called_at desc);

alter table public.llamados enable row level security;

drop policy if exists "llamados: admin all" on public.llamados;
create policy "llamados: admin all" on public.llamados
  for all using (auth.uid() = tenant_id) with check (auth.uid() = tenant_id);

drop policy if exists "llamados: enfermera select" on public.llamados;
create policy "llamados: enfermera select" on public.llamados
  for select using (
    exists (select 1 from public.anon_ctx() c
            where c.view_type = 'enfermera' and c.tenant_id = llamados.tenant_id)
  );

drop policy if exists "llamados: consultorio select own" on public.llamados;
create policy "llamados: consultorio select own" on public.llamados
  for select using (
    exists (select 1 from public.anon_ctx() c
            where c.view_type = llamados.consultorio and c.tenant_id = llamados.tenant_id)
  );

-- Sin policy de INSERT para el rol público: el único camino de escritura
-- es el RPC emitir_llamado (security definer), que re-deriva todos los
-- datos desde la ficha real — así ninguna vista puede forjar un llamado
-- con datos distintos a los reales.

-- ════════════════════════════════════════════════════════════════
-- 8. Habilitar Realtime en las tablas que lo necesitan
-- ════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'fichas'
  ) then
    alter publication supabase_realtime add table public.fichas;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'llamados'
  ) then
    alter publication supabase_realtime add table public.llamados;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════
-- 9. RPCs
-- ════════════════════════════════════════════════════════════════

-- 9.1 redeem_view_link — único punto donde se valida el share_token.
create or replace function public.redeem_view_link(p_token uuid)
returns public.view_type
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.view_links;
begin
  if auth.uid() is null then
    raise exception 'Se requiere una sesión antes de canjear el link.';
  end if;

  select * into v_link from public.view_links
   where share_token = p_token and active = true;

  if v_link is null then
    raise exception 'Link inválido o desactivado.';
  end if;

  insert into public.anon_sessions (user_id, tenant_id, view_type, view_link_id)
  values (auth.uid(), v_link.tenant_id, v_link.view_type, v_link.id)
  on conflict (user_id) do update
    set tenant_id    = excluded.tenant_id,
        view_type    = excluded.view_type,
        view_link_id = excluded.view_link_id,
        last_seen_at = now();

  return v_link.view_type;
end;
$$;

revoke all on function public.redeem_view_link(uuid) from public;
grant execute on function public.redeem_view_link(uuid) to authenticated;

-- 9.2 emitir_llamado — único INSERT posible en llamados; re-deriva todo
-- desde la ficha real (el cliente solo manda el id de la ficha).
create or replace function public.emitir_llamado(p_ficha_id uuid)
returns public.llamados
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx   record;
  v_ficha public.fichas;
  v_row   public.llamados;
begin
  select * into v_ctx from public.anon_ctx();
  if v_ctx is null then
    raise exception 'Sesión no vinculada a ninguna vista.';
  end if;

  select * into v_ficha from public.fichas
   where id = p_ficha_id and tenant_id = v_ctx.tenant_id;

  if v_ficha is null then
    raise exception 'Ficha no encontrada.';
  end if;
  if v_ficha.consultorio <> v_ctx.view_type then
    raise exception 'Esta ficha no está asignada a este consultorio.';
  end if;

  insert into public.llamados (tenant_id, ficha_id, consultorio, numero_ficha, nombre_paciente)
  values (v_ficha.tenant_id, v_ficha.id, v_ficha.consultorio, v_ficha.numero_ficha, v_ficha.nombre_paciente)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.emitir_llamado(uuid) from public;
grant execute on function public.emitir_llamado(uuid) to authenticated;

-- 9.3 marcar_procesado — único UPDATE posible de processed_by_archivista;
-- evita exponer un UPDATE directo de fichas al rol público (que podría
-- editar otras columnas si solo se restringiera por RLS de fila).
create or replace function public.marcar_procesado(p_ficha_id uuid, p_valor boolean)
returns public.fichas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx  record;
  v_row  public.fichas;
begin
  select * into v_ctx from public.anon_ctx();
  if v_ctx is null or v_ctx.view_type <> 'archivista' then
    raise exception 'No autorizado.';
  end if;

  update public.fichas
     set processed_by_archivista = p_valor
   where id = p_ficha_id and tenant_id = v_ctx.tenant_id
  returning * into v_row;

  if v_row is null then
    raise exception 'Ficha no encontrada.';
  end if;

  return v_row;
end;
$$;

revoke all on function public.marcar_procesado(uuid, boolean) from public;
grant execute on function public.marcar_procesado(uuid, boolean) to authenticated;

-- 9.4 iniciar_jornada — borra fichas+llamados del tenant. NO borra
-- view_links ni anon_sessions: los links deben seguir funcionando
-- día tras día sin que cada dispositivo tenga que re-abrirlos.
create or replace function public.iniciar_jornada()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Solo el administrador puede iniciar jornada.';
  end if;

  delete from public.llamados where tenant_id = auth.uid();
  delete from public.fichas   where tenant_id = auth.uid();
end;
$$;

revoke all on function public.iniciar_jornada() from public;
grant execute on function public.iniciar_jornada() to authenticated;

-- 9.5 regenerate_view_link — revoca un link filtrado: cambia el token
-- Y desconecta cualquier sesión anónima que ya lo hubiera canjeado,
-- para que el acceso viejo se corte de inmediato.
create or replace function public.regenerate_view_link(p_view_type public.view_type)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new uuid := gen_random_uuid();
begin
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'No autorizado.';
  end if;

  update public.view_links
     set share_token = v_new, active = true
   where tenant_id = auth.uid() and view_type = p_view_type;

  delete from public.anon_sessions
   where tenant_id = auth.uid() and view_type = p_view_type;

  return v_new;
end;
$$;

revoke all on function public.regenerate_view_link(public.view_type) from public;
grant execute on function public.regenerate_view_link(public.view_type) to authenticated;
