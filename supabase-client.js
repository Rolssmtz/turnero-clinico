/**
 * supabase-client.js
 * Turnero Clínico — capa de adaptación a Supabase.
 *
 * ═══════════════════════════════════════════════════════════
 *  CREDENCIALES — reemplazar con las del proyecto Supabase real.
 * ═══════════════════════════════════════════════════════════
 */

const SUPABASE_URL      = "https://iwhgaxtgsyvutrbmarge.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_nyE1-2V0MrNnj4UZ1IilXw_79onkNOb";

const SUPABASE_CONFIGURED = (
  SUPABASE_URL !== "https://TU_PROYECTO.supabase.co" &&
  SUPABASE_ANON_KEY !== "TU_ANON_KEY_PUBLICA_AQUI"
);

let supabaseClient = null;

if (SUPABASE_CONFIGURED && typeof window.supabase !== 'undefined') {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storageKey: 'turnero-auth-token'
    }
  });
  console.log('[Turnero] ✅ Supabase client inicializado');
} else if (!SUPABASE_CONFIGURED) {
  console.error('[Turnero] ⚠️ Supabase no configurado — edita supabase-client.js con tu URL y anon key.');
}

// Mapa de view_type <-> etiqueta legible, usado por toda la app.
const VIEW_LABELS = {
  archivista: 'Archivista',
  enfermera: 'Enfermera',
  consultorio_1: 'Consultorio 1',
  consultorio_2: 'Consultorio 2',
  consultorio_3: 'Consultorio 3',
  consultorio_dental: 'Consultorio Dental'
};

const ADMIN_VIEW_ORDER = [
  'archivista', 'enfermera', 'consultorio_1', 'consultorio_2', 'consultorio_3', 'consultorio_dental'
];

const CONSULTORIO_TYPES = ['consultorio_1', 'consultorio_2', 'consultorio_3', 'consultorio_dental'];

function _requireClient() {
  if (!supabaseClient) throw new Error('Supabase no está configurado. Revisa supabase-client.js.');
  return supabaseClient;
}

// ══════════════════════════════════════════════════════════
//  AUTENTICACIÓN — ADMINISTRADOR (email + contraseña)
// ══════════════════════════════════════════════════════════

async function adminSignUp(email, password) {
  const { data, error } = await _requireClient().auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function adminSignIn(email, password) {
  const { data, error } = await _requireClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function adminSignOut() {
  const { error } = await _requireClient().auth.signOut();
  if (error) throw error;
}

async function getSession() {
  const { data, error } = await _requireClient().auth.getSession();
  if (error) throw error;
  return data.session;
}

function onAuthChange(callback) {
  return _requireClient().auth.onAuthStateChange((event, session) => callback(event, session));
}

// ══════════════════════════════════════════════════════════
//  AUTENTICACIÓN — VISTAS PÚBLICAS (sesión anónima + link)
// ══════════════════════════════════════════════════════════

/**
 * Garantiza que exista una sesión (anónima si no hay ninguna) y la
 * sincroniza con Realtime. Se debe llamar antes de canjear un link.
 */
async function ensureAnonSession() {
  const client = _requireClient();
  let session = await getSession();

  if (!session) {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }

  if (session) {
    client.realtime.setAuth(session.access_token);
  }
  return session;
}

/** Canjea un share_token por acceso a una vista. Devuelve el view_type. */
async function redeemViewLink(token) {
  const { data, error } = await _requireClient().rpc('redeem_view_link', { p_token: token });
  if (error) throw error;
  return data;
}

/**
 * Mantiene Realtime autenticado incluso cuando el JWT anónimo rota.
 * Sin esto, una tablet dejada abierta todo el día deja de recibir
 * actualizaciones en silencio tras ~1h.
 */
function keepRealtimeAuthFresh() {
  onAuthChange((event, session) => {
    if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) {
      _requireClient().realtime.setAuth(session.access_token);
    }
  });
}

// ══════════════════════════════════════════════════════════
//  ADMIN — links de vistas, fichas, jornada
// ══════════════════════════════════════════════════════════

async function listViewLinks() {
  const { data, error } = await _requireClient()
    .from('view_links')
    .select('*')
    .order('view_type', { ascending: true });
  if (error) throw error;
  return data;
}

function buildShareUrl(shareToken) {
  return `${window.location.origin}/v/${shareToken}`;
}

async function regenerateViewLink(viewType) {
  const { data, error } = await _requireClient().rpc('regenerate_view_link', { p_view_type: viewType });
  if (error) throw error;
  return data;
}

async function crearFicha({ nombre_paciente, expediente, numero_ficha, consultorio }) {
  const client = _requireClient();
  const { data: { user } } = await client.auth.getUser();
  const { data, error } = await client
    .from('fichas')
    .insert({ nombre_paciente, expediente, numero_ficha, consultorio, tenant_id: user.id })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function iniciarJornada() {
  const { error } = await _requireClient().rpc('iniciar_jornada');
  if (error) throw error;
}

async function enviarJornadaCsv(toEmail) {
  const { data, error } = await _requireClient().functions.invoke('send-jornada-csv', {
    body: { to_email: toEmail }
  });
  if (error) throw error;
  return data;
}

// ══════════════════════════════════════════════════════════
//  DATOS COMPARTIDOS (fichas / llamados) — RLS filtra las filas
//  visibles según la sesión (admin o vista pública canjeada).
// ══════════════════════════════════════════════════════════

async function listFichas() {
  const { data, error } = await _requireClient()
    .from('fichas')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function marcarProcesado(fichaId, valor) {
  const { data, error } = await _requireClient().rpc('marcar_procesado', {
    p_ficha_id: fichaId,
    p_valor: valor
  });
  if (error) throw error;
  return data;
}

async function emitirLlamado(fichaId) {
  const { data, error } = await _requireClient().rpc('emitir_llamado', { p_ficha_id: fichaId });
  if (error) throw error;
  return data;
}

async function listLlamados(limit = 20) {
  const { data, error } = await _requireClient()
    .from('llamados')
    .select('*')
    .order('called_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

function subscribeTabla(tabla, callback) {
  const channel = _requireClient()
    .channel(`realtime:${tabla}:${Date.now()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: tabla }, callback)
    .subscribe();
  return () => _requireClient().removeChannel(channel);
}

// ══════════════════════════════════════════════════════════
//  API pública del módulo
// ══════════════════════════════════════════════════════════

window.Turnero = {
  SUPABASE_CONFIGURED,
  VIEW_LABELS,
  ADMIN_VIEW_ORDER,
  CONSULTORIO_TYPES,

  adminSignUp,
  adminSignIn,
  adminSignOut,
  getSession,
  onAuthChange,

  ensureAnonSession,
  redeemViewLink,
  keepRealtimeAuthFresh,

  listViewLinks,
  buildShareUrl,
  regenerateViewLink,
  crearFicha,
  iniciarJornada,
  enviarJornadaCsv,

  listFichas,
  marcarProcesado,
  emitirLlamado,
  listLlamados,
  subscribeTabla
};
