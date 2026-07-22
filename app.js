/**
 * app.js — Turnero Clínico
 * SPA sin bundler: una sección <section id="view-*"> por vista,
 * mostrada/ocultada por showView(). El routing decide, según la
 * URL, si arrancar el flujo de administrador o el de una vista
 * pública canjeando un link.
 */

const T = window.Turnero;

// ══════════════════════════════════════════════
//  UTILIDADES DE UI
// ══════════════════════════════════════════════

function showView(viewId) {
  document.querySelectorAll('.app-view').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(viewId);
  if (el) el.classList.add('active');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('duplicate key value') && msg.includes('numero_ficha')) {
    return 'Ya existe una ficha con ese número en la jornada actual.';
  }
  return msg;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function formatRelative(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins < 1) return 'hace un momento';
  if (mins === 1) return 'hace 1 min';
  return `hace ${mins} min`;
}

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ══════════════════════════════════════════════
//  ROUTING
// ══════════════════════════════════════════════

function boot() {
  if (!T || !T.SUPABASE_CONFIGURED) {
    showView('view-loading');
    document.querySelector('#view-loading p').textContent =
      'Supabase no está configurado. Edita supabase-client.js con tu URL y anon key.';
    return;
  }

  // Contrato de enrutamiento (intencional, no incidental):
  // - "/" es el ÚNICO lugar donde existen las vistas de login/registro
  //   (view-access) y de administrador (view-admin). bootstrapAdminApp()
  //   nunca las muestra desde una ruta /v/:token, ni bootstrapPublicView()
  //   las muestra desde "/".
  // - "/v/:token" siempre resuelve a su vista pública asignada (o a
  //   view-link-error si el token no es válido) y JAMÁS cae en
  //   view-access/view-admin, sin importar si ese mismo navegador tiene
  //   además una sesión de administrador activa en "/".
  // - La única forma de volver a ver el login/registro en "/" es que el
  //   administrador cierre sesión explícitamente (botón "Cerrar sesión"
  //   → evento SIGNED_OUT en wireAccessForms/bootstrapAdminApp).
  const match = window.location.pathname.match(/^\/v\/([0-9a-f-]{36})\/?$/i);
  if (match) {
    T.initClient('public');
    bootstrapPublicView(match[1]);
  } else {
    T.initClient('admin');
    bootstrapAdminApp();
  }
}

// ══════════════════════════════════════════════
//  FLUJO ADMINISTRADOR
// ══════════════════════════════════════════════

async function bootstrapAdminApp() {
  wireAccessForms();
  wireAdminDashboard();

  T.onAuthChange((event, session) => {
    if (event === 'SIGNED_OUT') showView('view-access');
  });

  const session = await T.getSession();
  if (session && !session.user.is_anonymous) {
    showView('view-admin');
    loadAdminDashboard();
  } else {
    showView('view-access');
  }
}

function wireAccessForms() {
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    formLogin.style.display = '';
    formRegister.style.display = 'none';
  });

  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    formRegister.style.display = '';
    formLogin.style.display = 'none';
  });

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    errorEl.style.display = 'none';
    try {
      await T.adminSignIn(
        document.getElementById('login-email').value.trim(),
        document.getElementById('login-password').value
      );
      showView('view-admin');
      loadAdminDashboard();
    } catch (err) {
      errorEl.textContent = friendlyError(err);
      errorEl.style.display = 'block';
    }
  });

  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('register-error');
    errorEl.style.display = 'none';
    try {
      await T.adminSignUp(
        document.getElementById('register-email').value.trim(),
        document.getElementById('register-password').value
      );
      toast('Cuenta creada. Revisa tu correo si se requiere confirmación.', 'success');
      const session = await T.getSession();
      if (session && !session.user.is_anonymous) {
        showView('view-admin');
        loadAdminDashboard();
      } else {
        tabLogin.click();
      }
    } catch (err) {
      errorEl.textContent = friendlyError(err);
      errorEl.style.display = 'block';
    }
  });
}

function wireAdminDashboard() {
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await T.adminSignOut();
    showView('view-access');
  });

  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`admin-tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  document.getElementById('form-ficha').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('ficha-error');
    errorEl.style.display = 'none';
    try {
      await T.crearFicha({
        nombre_paciente: document.getElementById('ficha-nombre').value.trim(),
        expediente: document.getElementById('ficha-expediente').value.trim(),
        numero_ficha: document.getElementById('ficha-numero').value.trim(),
        consultorio: document.getElementById('ficha-consultorio').value
      });
      toast('Ficha guardada correctamente.', 'success');
      e.target.reset();
    } catch (err) {
      errorEl.textContent = friendlyError(err);
      errorEl.style.display = 'block';
    }
  });

  document.getElementById('btn-iniciar-jornada').addEventListener('click', () => openModal('modal-iniciar-jornada'));
  document.getElementById('btn-cancelar-jornada').addEventListener('click', () => closeModal('modal-iniciar-jornada'));
  document.getElementById('btn-confirmar-jornada').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await T.iniciarJornada();
      toast('Jornada iniciada. Todos los registros del día fueron eliminados.', 'success');
      closeModal('modal-iniciar-jornada');
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      e.target.disabled = false;
    }
  });
}

async function loadAdminDashboard() {
  try {
    const links = await T.listViewLinks();
    renderLinkList(links);
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

function renderLinkList(links) {
  const container = document.getElementById('link-list');
  container.innerHTML = links.map(link => {
    const url = T.buildShareUrl(link.share_token);
    return `
      <div class="link-row" data-view-type="${link.view_type}">
        <div>
          <div class="link-name">${escapeHtml(T.VIEW_LABELS[link.view_type] || link.view_type)}</div>
          <div class="link-url">${escapeHtml(url)}</div>
        </div>
        <div class="link-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="regenerate">Regenerar</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="share">Compartir</button>
        </div>
      </div>`;
  }).join('') || '<p class="empty-state">No hay vistas configuradas.</p>';

  container.querySelectorAll('.link-row').forEach(row => {
    const viewType = row.dataset.viewType;
    const url = row.querySelector('.link-url').textContent;

    row.querySelector('[data-action="share"]').addEventListener('click', () => shareLink(viewType, url));
    row.querySelector('[data-action="regenerate"]').addEventListener('click', async () => {
      if (!confirm('Esto invalida el link actual de inmediato. ¿Continuar?')) return;
      try {
        await T.regenerateViewLink(viewType);
        toast('Link regenerado.', 'success');
        loadAdminDashboard();
      } catch (err) {
        toast(friendlyError(err), 'error');
      }
    });
  });
}

function shareLink(viewType, url) {
  const label = T.VIEW_LABELS[viewType] || viewType;
  const text = `Acceso a la vista ${label} — Turnero Clínico`;

  if (navigator.share) {
    navigator.share({ title: 'Turnero Clínico', text, url }).catch(() => {});
    return;
  }

  navigator.clipboard?.writeText(url).then(() => toast('Link copiado al portapapeles.', 'success'));
  window.open(`https://wa.me/?text=${encodeURIComponent(text + ': ' + url)}`, '_blank', 'noopener');
}

// ══════════════════════════════════════════════
//  FLUJO VISTAS PÚBLICAS (/v/:token)
//  Nunca muestra view-access ni view-admin (ver contrato de
//  enrutamiento en boot()) — cualquier fallo cae en view-link-error.
// ══════════════════════════════════════════════

async function bootstrapPublicView(token) {
  try {
    await T.ensureAnonSession();
    const viewType = await T.redeemViewLink(token);
    T.keepRealtimeAuthFresh();

    if (viewType === 'archivista') {
      showView('view-archivista');
      initArchivista();
    } else if (viewType === 'enfermera') {
      showView('view-enfermera');
      initEnfermera();
    } else if (T.CONSULTORIO_TYPES.includes(viewType)) {
      showView('view-consultorio');
      document.getElementById('consultorio-badge').textContent = T.VIEW_LABELS[viewType];
      initConsultorio(viewType);
    } else {
      showView('view-link-error');
    }
  } catch (err) {
    console.error(err);
    showView('view-link-error');
  }
}

// ── Archivista ──────────────────────────────────

function initArchivista() {
  const render = async () => {
    try {
      const fichas = await T.listFichas();
      renderArchivista(fichas);
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  };
  render();
  T.subscribeTabla('fichas', render);
}

function renderArchivista(fichas) {
  const tbody = document.getElementById('archivista-rows');
  const empty = document.getElementById('archivista-empty');

  if (!fichas.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = fichas.map(f => `
    <tr class="${f.processed_by_archivista ? 'row-done' : 'row-pending'}" data-id="${f.id}">
      <td><input type="checkbox" class="checkbox-lg" ${f.processed_by_archivista ? 'checked' : ''}></td>
      <td>${escapeHtml(f.numero_ficha)}</td>
      <td>${escapeHtml(f.nombre_paciente)}</td>
      <td>${escapeHtml(f.expediente)}</td>
      <td>${escapeHtml(T.VIEW_LABELS[f.consultorio] || f.consultorio)}</td>
      <td>${formatTime(f.created_at)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach(row => {
    row.querySelector('input[type=checkbox]').addEventListener('change', async (e) => {
      const checked = e.target.checked;
      row.classList.toggle('row-done', checked);
      row.classList.toggle('row-pending', !checked);
      try {
        await T.marcarProcesado(row.dataset.id, checked);
      } catch (err) {
        toast(friendlyError(err), 'error');
        e.target.checked = !checked;
        row.classList.toggle('row-done', !checked);
        row.classList.toggle('row-pending', checked);
      }
    });
  });
}

// ── Enfermera (turnero) ─────────────────────────

function initEnfermera() {
  const render = async () => {
    try {
      const llamados = await T.listLlamados(20);
      renderTurnero(llamados);
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  };
  render();
  T.subscribeTabla('llamados', render);
  setInterval(render, 20000);
}

function renderTurnero(llamados) {
  const latestWrap = document.getElementById('turnero-latest-wrap');
  const historyWrap = document.getElementById('turnero-history');
  const empty = document.getElementById('turnero-empty');

  if (!llamados.length) {
    latestWrap.innerHTML = '';
    historyWrap.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const [latest, ...rest] = llamados;

  latestWrap.innerHTML = `
    <div class="turnero-latest">
      <div class="label">Ficha</div>
      <div class="ficha-num">${escapeHtml(latest.numero_ficha)}</div>
      <div class="paciente">${escapeHtml(latest.nombre_paciente)}</div>
      <div class="consultorio">${escapeHtml(T.VIEW_LABELS[latest.consultorio] || latest.consultorio)}</div>
    </div>`;

  historyWrap.innerHTML = rest.map(l => `
    <div class="turnero-history-row">
      <span class="ficha-num">${escapeHtml(l.numero_ficha)}</span>
      <span class="paciente">${escapeHtml(l.nombre_paciente)}</span>
      <span class="consultorio">${escapeHtml(T.VIEW_LABELS[l.consultorio] || l.consultorio)} · ${formatTime(l.called_at)}</span>
    </div>`).join('');
}

// ── Consultorio ──────────────────────────────────

function initConsultorio(viewType) {
  const render = async () => {
    try {
      const [fichas, llamados] = await Promise.all([T.listFichas(), T.listLlamados(200)]);
      renderConsultorio(fichas, llamados);
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  };
  render();
  T.subscribeTabla('fichas', render);
  T.subscribeTabla('llamados', render);
  setInterval(render, 20000);
}

function renderConsultorio(fichas, llamados) {
  const container = document.getElementById('consultorio-list');
  const empty = document.getElementById('consultorio-empty');

  if (!fichas.length) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const lastCallByFicha = {};
  llamados.forEach(l => {
    if (!lastCallByFicha[l.ficha_id] || l.called_at > lastCallByFicha[l.ficha_id]) {
      lastCallByFicha[l.ficha_id] = l.called_at;
    }
  });

  container.innerHTML = fichas.map(f => {
    const lastCall = lastCallByFicha[f.id];
    return `
      <div class="patient-card" data-id="${f.id}">
        <div class="patient-info">
          <h3>${escapeHtml(f.nombre_paciente)}</h3>
          <p>Ficha ${escapeHtml(f.numero_ficha)} · Exp. ${escapeHtml(f.expediente)}</p>
          ${lastCall ? `<p class="called-tag">Llamado ${formatRelative(lastCall)}</p>` : ''}
        </div>
        <button type="button" class="btn btn-primary btn-llamar">${lastCall ? 'Volver a llamar' : 'Llamado'}</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.patient-card').forEach(card => {
    card.querySelector('.btn-llamar').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await T.emitirLlamado(card.dataset.id);
        toast('Paciente llamado.', 'success');
      } catch (err) {
        toast(friendlyError(err), 'error');
      } finally {
        e.target.disabled = false;
      }
    });
  });
}

// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', boot);
