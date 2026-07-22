// send-jornada-csv
// Edge Function invocada solo por el administrador autenticado desde
// el dashboard (botón "Almacenar jornada"). Genera un CSV de fichas y
// llamados del tenant y lo envía por correo vía Resend.
//
// Secrets requeridos (supabase secrets set ...):
//   RESEND_API_KEY   — API key de Resend (capa gratuita)
//   RESEND_FROM      — remitente verificado, ej. "Turnero <no-reply@tudominio.com>"
//                       (usar "onboarding@resend.dev" solo para pruebas)
//
// Variables de entorno ya provistas por el runtime de Supabase:
//   SUPABASE_URL, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'onboarding@resend.dev';

function csvEscape(value: unknown): string {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',');
  const body = rows.map(row => columns.map(col => csvEscape(row[col])).join(',')).join('\n');
  return `${header}\n${body}`;
}

function base64Encode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Falta encabezado de autorización.' }), { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user || userData.user.is_anonymous) {
    return new Response(JSON.stringify({ error: 'No autorizado.' }), { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (!profile) {
    return new Response(JSON.stringify({ error: 'Solo un administrador puede almacenar la jornada.' }), { status: 403 });
  }

  let body: { to_email?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Cuerpo de la petición inválido.' }), { status: 400 });
  }

  const toEmail = body.to_email?.trim();
  if (!toEmail) {
    return new Response(JSON.stringify({ error: 'Falta el correo destino.' }), { status: 400 });
  }

  // Las consultas corren con el JWT del admin: RLS ya las acota a su propio tenant.
  const [{ data: fichas, error: fichasErr }, { data: llamados, error: llamadosErr }] = await Promise.all([
    supabase.from('fichas').select('*').order('created_at', { ascending: true }),
    supabase.from('llamados').select('*').order('called_at', { ascending: true })
  ]);

  if (fichasErr || llamadosErr) {
    return new Response(JSON.stringify({ error: 'Error al leer los datos de la jornada.' }), { status: 500 });
  }

  const now = new Date();
  const fechaLegible = now.toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
  const fechaArchivo = now.toISOString().replace(/[:.]/g, '-');

  const fichasCsv = toCsv(fichas ?? [], [
    'numero_ficha', 'nombre_paciente', 'expediente', 'consultorio', 'processed_by_archivista', 'created_at'
  ]);
  const llamadosCsv = toCsv(llamados ?? [], [
    'numero_ficha', 'nombre_paciente', 'consultorio', 'called_at'
  ]);

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY no está configurado en los secrets de Supabase.' }), { status: 500 });
  }

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [toEmail],
      subject: `Jornada Turnero Clínico — ${fechaLegible}`,
      html: `<p>Adjunto el respaldo de la jornada generado el ${fechaLegible}.</p>`,
      attachments: [
        { filename: `fichas_${fechaArchivo}.csv`, content: base64Encode(fichasCsv) },
        { filename: `llamados_${fechaArchivo}.csv`, content: base64Encode(llamadosCsv) }
      ]
    })
  });

  if (!resendResp.ok) {
    const detail = await resendResp.text();
    return new Response(JSON.stringify({ error: `Resend rechazó el envío: ${detail}` }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true, sent_to: toEmail }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});
