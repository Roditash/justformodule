const state = {
  user: null,
  token: localStorage.getItem('token') || null,
  dashboard: null,
  resources: [],
  reservations: [],
  loans: [],
  history: [],
  lastUpdated: null
};

const api = {
  async request(path, options = {}) {
    const token = state.token;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new Error(typeof data === 'string' ? data : data.error || 'Error de la solicitud');
    }

    return data;
  }
};

function showNotice(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${type === 'error' ? '!' : '✓'}</div>
    <div class="toast-copy">
      <strong>${type === 'error' ? 'Atención' : 'Hecho'}</strong>
      <span>${message}</span>
    </div>
  `;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('is-hiding');
    setTimeout(() => toast.remove(), 260);
  }, 3200);
}

function setAuth(user) {
  state.user = user;
  const loginSection = document.getElementById('login-section');
  const appContainer = document.getElementById('app');
  const userPanel = document.getElementById('userPanel');
  const isLoggedIn = Boolean(user);

  document.body.classList.toggle('logged-in', isLoggedIn);
  document.body.classList.toggle('logged-out', !isLoggedIn);

  if (user) {
    loginSection.classList.add('hidden');
    appContainer.classList.remove('hidden');
    userPanel.classList.remove('hidden');
    document.getElementById('currentUserName').textContent = user.name;
    document.getElementById('currentUserRole').textContent = user.role === 'admin' ? 'Administrador' : 'Usuario';
  } else {
    loginSection.classList.remove('hidden');
    appContainer.classList.add('hidden');
    userPanel.classList.add('hidden');
  }
}

function showSection(targetId) {
  document.querySelectorAll('.nav-btn').forEach((button) => {
    const isActive = button.dataset.target === targetId;
    button.classList.toggle('active', isActive);
  });

  document.querySelectorAll('.panel').forEach((panel) => {
    if (panel.id === targetId) {
      panel.classList.add('active-panel');
      panel.classList.remove('hidden-panel');
    } else if (panel.id === 'login-section') {
      panel.classList.remove('hidden-panel');
    } else {
      panel.classList.remove('active-panel');
      panel.classList.add('hidden-panel');
    }
  });
}

function formatLastUpdated(value) {
  if (!value) return 'Sincronización pendiente';
  return `Última actualización: ${new Date(value).toLocaleString()}`;
}

function updateSyncStatus(isLoading = false) {
  const liveBadge = document.getElementById('liveBadge');
  if (!liveBadge) return;
  liveBadge.textContent = isLoading ? 'Actualizando...' : 'Sincronizado';
  liveBadge.style.background = isLoading ? '#fff0b5' : '#dce9d0';
  liveBadge.style.color = isLoading ? '#60400b' : '#254a2c';
  liveBadge.style.borderColor = isLoading ? '#8a6413' : '#476b3d';

  const lastUpdated = document.getElementById('lastUpdated');
  if (lastUpdated) {
    lastUpdated.textContent = formatLastUpdated(state.lastUpdated);
  }
}

function renderStats() {
  const totals = state.dashboard?.totals || {};
  const cards = [
    ['Mesas totales', totals.total_tables || 0],
    ['Mesas disponibles', totals.available_tables || 0],
    ['Mesas reservadas', totals.reserved_tables || 0],
    ['Mesas prestadas', totals.borrowed_tables || 0],
    ['Sillas totales', totals.total_chairs || 0],
    ['Sillas disponibles', totals.available_chairs || 0],
    ['Sillas reservadas', totals.reserved_chairs || 0],
    ['Sillas prestadas', totals.borrowed_chairs || 0],
    ['Reservas pendientes', totals.pending_reservations || 0],
    ['Préstamos activos', totals.active_loans || 0],
    ['Préstamos vencidos', totals.overdue_loans || 0],
    ['Devoluciones pendientes', totals.pending_returns || 0]
  ];

  const totalAvailable = (Number(totals.available_tables || 0) + Number(totals.available_chairs || 0));
  const totalReserved = (Number(totals.reserved_tables || 0) + Number(totals.reserved_chairs || 0));
  const totalBorrowed = (Number(totals.borrowed_tables || 0) + Number(totals.borrowed_chairs || 0));

  const heroAvailable = document.getElementById('heroAvailable');
  const heroReserved = document.getElementById('heroReserved');
  const heroBorrowed = document.getElementById('heroBorrowed');

  if (heroAvailable) heroAvailable.textContent = totalAvailable;
  if (heroReserved) heroReserved.textContent = totalReserved;
  if (heroBorrowed) heroBorrowed.textContent = totalBorrowed;

  const dashboardCards = document.getElementById('dashboardCards');
  dashboardCards.innerHTML = cards.map(([label, value]) => `
    <div class="stat-card">
      <span class="label">${label}</span>
      <span class="value">${value}</span>
    </div>
  `).join('');
}

function renderResources() {
  const body = document.getElementById('resourceTableBody');
  body.innerHTML = (state.resources || []).map((resource) => `
    <tr>
      <td>${resource.name}</td>
      <td>${resource.total_quantity}</td>
      <td>${resource.available_quantity}</td>
      <td>${resource.reserved_quantity}</td>
      <td>${resource.borrowed_quantity}</td>
      <td><span class="badge ${resource.status === 'disponible' ? 'finalized' : resource.status === 'agotado' ? 'cancelled' : 'pending'}">${resource.status}</span></td>
    </tr>
  `).join('');
}

function formatStatusBadge(status) {
  const map = {
    pendiente: 'pending',
    confirmada: 'confirmed',
    cancelada: 'cancelled',
    finalizada: 'finalized',
    activo: 'active',
    parcialmente_devuelto: 'partial',
    devuelto: 'returned',
    vencido: 'overdue'
  };

  return map[status] || 'pending';
}

function renderReservations() {
  const body = document.getElementById('reservationTableBody');
  body.innerHTML = (state.reservations || []).map((reservation) => `
    <tr>
      <td>${reservation.user_name}</td>
      <td>${reservation.resource_type}</td>
      <td>${reservation.quantity}</td>
      <td>${reservation.reserved_date}</td>
      <td><span class="badge ${formatStatusBadge(reservation.status)}">${reservation.status}</span></td>
      <td>
        ${reservation.status === 'pendiente' || reservation.status === 'confirmada' ? `
          <button class="action-btn" data-action="cancel-reservation" data-id="${reservation.id}">Cancelar</button>
          ${reservation.status === 'pendiente' ? `<button class="action-btn" data-action="confirm-reservation" data-id="${reservation.id}">Confirmar</button>` : ''}
        ` : '-' }
      </td>
    </tr>
  `).join('');
}

function renderLoans() {
  const body = document.getElementById('loanTableBody');
  body.innerHTML = (state.loans || []).map((loan) => `
    <tr>
      <td>${loan.user_name}</td>
      <td>${loan.resource_type}</td>
      <td>${loan.quantity}</td>
      <td>${loan.loan_date}</td>
      <td><span class="badge ${formatStatusBadge(loan.status)}">${loan.status}</span></td>
      <td>
        ${loan.status !== 'devuelto' ? `<button class="action-btn" data-action="return-loan" data-id="${loan.id}">Devolver</button>` : '-'}
      </td>
    </tr>
  `).join('');
}

function renderHistory() {
  const body = document.getElementById('historyTableBody');
  body.innerHTML = (state.history || []).slice(0, 20).map((entry) => `
    <tr>
      <td>${new Date(entry.created_at).toLocaleString()}</td>
      <td>${entry.user_name || 'Sistema'}</td>
      <td>${entry.operation_type}</td>
      <td>${entry.resource_type || '-'}</td>
      <td>${entry.quantity}</td>
      <td>${entry.state_before || '-'}</td>
      <td>${entry.state_after || '-'}</td>
    </tr>
  `).join('');
}

async function loadDashboard() {
  state.dashboard = await api.request('/api/dashboard');
}

async function loadResources() {
  state.resources = await api.request('/api/resources');
}

async function loadReservations() {
  state.reservations = await api.request('/api/reservations');
}

async function loadLoans() {
  state.loans = await api.request('/api/loans');
}

async function loadHistory() {
  state.history = await api.request('/api/history');
}

async function loadAllData() {
  if (!state.token) return;

  updateSyncStatus(true);

  await Promise.all([
    loadDashboard(),
    loadResources(),
    loadReservations(),
    loadLoans(),
    loadHistory()
  ]);

  state.lastUpdated = new Date().toISOString();
  renderStats();
  renderResources();
  renderReservations();
  renderLoans();
  renderHistory();
  updateSyncStatus(false);
}

function loadPaypalSdk(clientId) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const params = new URLSearchParams({
      'client-id': clientId,
      currency: 'USD',
      intent: 'capture'
    });
    script.src = `https://www.paypal.com/sdk/js?${params}`;
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar el SDK de PayPal Sandbox.'));
    document.head.appendChild(script);
  });
}

async function initializePaypalDemo() {
  const status = document.getElementById('paypalStatus');
  try {
    const config = await api.request('/api/paypal/config');
    if (!config.configured || !config.clientId) {
      status.textContent = 'Configura PAYPAL_SANDBOX_CLIENT_ID y PAYPAL_SANDBOX_CLIENT_SECRET en el servidor para activar el botón de prueba.';
      return;
    }

    await loadPaypalSdk(config.clientId);
    if (!window.paypal) {
      throw new Error('El SDK de PayPal no está disponible.');
    }

    await window.paypal.Buttons({
      createOrder: async () => {
        const amount = document.getElementById('paypalAmount').value;
        const order = await api.request('/api/paypal/orders', {
          method: 'POST',
          body: JSON.stringify({ amount })
        });
        return order.id;
      },
      onApprove: (data) => {
        status.textContent = `Orden ${data.orderID} aprobada en Sandbox. No se capturó ni cobró el pago.`;
        showNotice('Orden de prueba aprobada; no se realizó ningún cobro.', 'success');
      },
      onCancel: () => {
        status.textContent = 'Prueba cancelada. No se realizó ningún cobro.';
      },
      onError: (error) => {
        console.error('Error durante la demostración de PayPal Sandbox:', error);
        status.textContent = 'No se pudo completar la prueba. Revisa la configuración de Sandbox e inténtalo de nuevo.';
        showNotice('No se pudo completar la prueba de PayPal.', 'error');
      }
    }).render('#paypalButtonContainer');

    status.textContent = 'PayPal Sandbox listo. Usa una cuenta compradora de prueba; no se cobrará dinero real.';
  } catch (error) {
    console.error('No se pudo inicializar PayPal Sandbox:', error);
    status.textContent = error.message || 'No se pudo cargar la demostración de PayPal.';
  }
}

async function initialize() {
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => showSection(button.dataset.target));
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    if (!state.token) return;
    try {
      await loadAllData();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      if (state.token) {
        await api.request('/api/logout', { method: 'POST' });
      }
    } catch (error) {
      console.error(error);
    } finally {
      localStorage.removeItem('token');
      state.token = null;
      state.user = null;
      state.lastUpdated = null;
      updateSyncStatus(false);
      setAuth(null);
      document.body.classList.add('logged-out');
      document.body.classList.remove('logged-in');
      window.location.reload();
    }
  });

  const loginProfiles = {
    admin: { username: 'admin', password: 'admin123' },
    usuario: { username: 'usuario', password: 'usuario123' },
    demo: { username: 'admin', password: 'admin123' }
  };

  document.querySelectorAll('.auth-option').forEach((button) => {
    button.addEventListener('click', () => {
      const profile = loginProfiles[button.dataset.loginRole];
      if (!profile) return;

      document.getElementById('username').value = profile.username;
      document.getElementById('password').value = profile.password;

      document.querySelectorAll('.auth-option').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
      const result = await api.request('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem('token', result.token);
      state.token = result.token;
      setAuth(result.user);
      await loadAllData();
      window.location.reload();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  document.getElementById('resourceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const resourceType = document.getElementById('resourceType').value;
    const totalQuantity = Number(document.getElementById('resourceQuantity').value);

    try {
      const exists = (state.resources || []).some((item) => item.resource_type === resourceType);
      if (exists) {
        await api.request(`/api/resources/${resourceType}`, {
          method: 'PUT',
          body: JSON.stringify({ total_quantity: totalQuantity })
        });
      } else {
        await api.request('/api/resources', {
          method: 'POST',
          body: JSON.stringify({ resource_type: resourceType, total_quantity: totalQuantity })
        });
      }
      await loadAllData();
      showNotice('Inventario actualizado correctamente.', 'success');
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  document.getElementById('reservationForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      resource_type: document.getElementById('reservationResource').value,
      quantity: Number(document.getElementById('reservationQuantity').value),
      reserved_date: document.getElementById('reservationDate').value,
      start_time: document.getElementById('reservationStart').value || null,
      end_time: document.getElementById('reservationEnd').value || null,
      observations: document.getElementById('reservationObservations').value || null
    };

    try {
      await api.request('/api/reservations', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await loadAllData();
      showNotice('Reserva creada correctamente.', 'success');
      event.target.reset();
      document.getElementById('reservationQuantity').value = 1;
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  document.getElementById('loanForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      resource_type: document.getElementById('loanResource').value,
      quantity: Number(document.getElementById('loanQuantity').value),
      loan_date: document.getElementById('loanDate').value,
      due_date: document.getElementById('dueDate').value,
      observations: document.getElementById('loanObservations').value || null
    };

    try {
      await api.request('/api/loans', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await loadAllData();
      showNotice('Préstamo registrado correctamente.', 'success');
      event.target.reset();
      document.getElementById('loanQuantity').value = 1;
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  document.getElementById('reservationTableBody').addEventListener('click', async (event) => {
    const target = event.target;
    const id = Number(target.dataset.id);
    if (!id) return;

    try {
      if (target.dataset.action === 'cancel-reservation') {
        await api.request(`/api/reservations/${id}/cancel`, { method: 'PUT' });
      }
      if (target.dataset.action === 'confirm-reservation') {
        await api.request(`/api/reservations/${id}/confirm`, { method: 'PUT' });
      }
      await loadAllData();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  document.getElementById('loanTableBody').addEventListener('click', async (event) => {
    const target = event.target;
    const id = Number(target.dataset.id);
    if (!id) return;

    if (target.dataset.action === 'return-loan') {
      const quantity = Number(prompt('Cantidad a devolver:', '1'));
      if (!quantity || quantity <= 0) return;
      try {
        await api.request(`/api/loans/${id}/return`, {
          method: 'POST',
          body: JSON.stringify({ quantity, returned_date: new Date().toISOString().slice(0, 10) })
        });
        await loadAllData();
      } catch (error) {
        showNotice(error.message, 'error');
      }
    }
  });

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('reservationDate').value = today;
  document.getElementById('loanDate').value = today;
  document.getElementById('dueDate').value = today;

  if (state.token) {
    try {
      const authData = await api.request('/api/me');
      setAuth(authData);
      await loadAllData();
      await initializePaypalDemo();
    } catch (error) {
      console.error(error);
      localStorage.removeItem('token');
      state.token = null;
      setAuth(null);
    }
  } else {
    setAuth(null);
  }

  window.addEventListener('focus', async () => {
    if (state.token) {
      try {
        await loadAllData();
      } catch (error) {
        console.error(error);
      }
    }
  });

  setInterval(() => {
    if (state.token) {
      loadAllData().catch((error) => console.error(error));
    }
  }, 20000);

  updateSyncStatus(false);
  showSection('dashboard-section');
}

initialize();
