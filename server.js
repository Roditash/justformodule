const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  initializeDb,
  db,
  getUserByCredentials,
  getUserById,
  getResources,
  updateResource,
  createResource,
  getDashboardData,
  getReservations,
  createReservation,
  confirmReservation,
  cancelReservation,
  getLoans,
  createLoan,
  registerReturn,
  getHistory,
  registerSession,
  isSessionActive,
  clearSession,
  listUsers,
  createUser
} = require('./src/db');
const { createToken, verifyToken, extractTokenFromRequest } = require('./src/auth');
const { buildInventorySummary } = require('./src/services/inventoryService');
const { getPaypalSandboxConfig, createPaypalDemoOrder } = require('./src/paypal');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
let databaseInitialization;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function ensureDatabaseInitialized() {
  if (!databaseInitialization) {
    databaseInitialization = initializeDb().catch((error) => {
      databaseInitialization = null;
      throw error;
    });
  }
  return databaseInitialization;
}

app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : { origin: false }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', asyncRoute(async (req, res, next) => {
  await ensureDatabaseInitialized();
  next();
}));

async function requireAuth(req, res, next) {
  const token = extractTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Debe iniciar sesión para realizar esta acción.' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }

  try {
    if (!(await isSessionActive(token))) {
      return res.status(401).json({ error: 'La sesión ya no está activa.' });
    }
    const user = await getUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes permisos de administrador.' });
  }
  return next();
}

function respondWithError(res, error) {
  const databaseError = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);
  if (databaseError) {
    console.error('Error de base de datos:', error.message);
    if (error.code === '23505') return res.status(409).json({ error: 'El registro ya existe.' });
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
  const status = error.statusCode || 400;
  return res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : error.message });
}

app.get('/api/health', asyncRoute(async (req, res) => {
  await db.query('SELECT 1');
  return res.json({ ok: true, database: 'connected' });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !username.trim() || username.length > 255 ||
      typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios.' });
  }

  const user = await getUserByCredentials(username.trim(), password);
  if (!user) {
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  }

  const token = createToken(user);
  await registerSession(token, user.id, new Date(verifyToken(token).exp * 1000));

  return res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    }
  });
}));

app.post('/api/logout', requireAuth, asyncRoute(async (req, res) => {
  const token = extractTokenFromRequest(req);
  await clearSession(token);
  return res.json({ ok: true, message: 'Sesión cerrada.' });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  return res.json({
    id: req.user.id,
    name: req.user.name,
    username: req.user.username,
    role: req.user.role
  });
}));

app.get('/api/paypal/config', requireAuth, asyncRoute(async (req, res) => {
  return res.json(getPaypalSandboxConfig());
}));

app.post('/api/paypal/orders', requireAuth, asyncRoute(async (req, res) => {
  try {
    const order = await createPaypalDemoOrder(req.body?.amount);
    return res.status(201).json(order);
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 503) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('No se pudo crear la orden de demostración de PayPal Sandbox:', error.message);
    return res.status(502).json({ error: 'No se pudo crear la orden en PayPal Sandbox. Inténtalo de nuevo.' });
  }
}));

app.get('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  return res.json(await listUsers());
}));

app.post('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { name, username, password, role } = req.body || {};
  if (typeof name !== 'string' || typeof username !== 'string' ||
      typeof password !== 'string' || typeof role !== 'string') {
    return res.status(400).json({ error: 'Faltan datos del usuario.' });
  }

  try {
    const user = await createUser({ name, username, password, role });
    return res.status(201).json(user);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.get('/api/resources', requireAuth, asyncRoute(async (req, res) => {
  return res.json(await getResources());
}));

app.get('/api/admin/summary', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const resources = await getResources();
  const dashboard = await getDashboardData();
  return res.json({
    dashboard,
    inventory: resources,
    summary: buildInventorySummary(resources)
  });
}));

app.post('/api/resources', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { resource_type, total_quantity, name } = req.body || {};
  if (typeof resource_type !== 'string' || total_quantity === undefined || total_quantity === null || total_quantity === '') {
    return res.status(400).json({ error: 'Tipo y cantidad total son obligatorios.' });
  }

  try {
    const existing = (await getResources()).find((resource) => resource.resource_type === String(resource_type).trim().toLowerCase());
    if (existing) {
      const resource = await updateResource({
        resource_type: String(resource_type).trim().toLowerCase(),
        total_quantity,
        userId: req.user.id
      });
      return res.json(resource);
    }

    const resource = await createResource({ resource_type, total_quantity, name, userId: req.user.id });
    return res.status(201).json(resource);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.put('/api/resources/:resource_type', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { resource_type } = req.params;
  const { total_quantity, status } = req.body || {};

  try {
    const resource = await updateResource({
      resource_type,
      total_quantity,
      status,
      userId: req.user.id
    });
    return res.json(resource);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.get('/api/dashboard', requireAuth, asyncRoute(async (req, res) => {
  return res.json(await getDashboardData());
}));

app.get('/api/reservations', requireAuth, asyncRoute(async (req, res) => {
  return res.json(await getReservations({ userId: req.user.id, isAdmin: req.user.role === 'admin' }));
}));

app.post('/api/reservations', requireAuth, asyncRoute(async (req, res) => {
  const { resource_type, quantity, reserved_date, start_time, end_time, observations } = req.body || {};
  if (typeof resource_type !== 'string' || quantity === undefined || quantity === null || quantity === '' || !reserved_date) {
    return res.status(400).json({ error: 'Faltan datos requeridos para la reserva.' });
  }

  try {
    const reservation = await createReservation({
      userId: req.user.id,
      resource_type,
      quantity,
      reserved_date,
      start_time,
      end_time,
      observations
    });
    return res.status(201).json(reservation);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.put('/api/reservations/:id/confirm', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const reservationId = Number(req.params.id);
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ error: 'El identificador de reserva no es válido.' });
  }
  try {
    const reservation = await confirmReservation({
      reservationId,
      userId: req.user.id
    });
    return res.json(reservation);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.put('/api/reservations/:id/cancel', requireAuth, asyncRoute(async (req, res) => {
  const reservationId = Number(req.params.id);
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ error: 'El identificador de reserva no es válido.' });
  }
  try {
    const reservation = await cancelReservation({
      reservationId,
      userId: req.user.id,
      isAdmin: req.user.role === 'admin'
    });
    return res.json(reservation);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.get('/api/loans', requireAuth, asyncRoute(async (req, res) => {
  return res.json(await getLoans({ userId: req.user.id, isAdmin: req.user.role === 'admin' }));
}));

app.post('/api/loans', requireAuth, asyncRoute(async (req, res) => {
  const { resource_type, quantity, loan_date, due_date, observations } = req.body || {};
  if (typeof resource_type !== 'string' || quantity === undefined || quantity === null || quantity === '' || !loan_date || !due_date) {
    return res.status(400).json({ error: 'Faltan datos requeridos del préstamo.' });
  }

  try {
    const loan = await createLoan({
      userId: req.user.id,
      resource_type,
      quantity,
      loan_date,
      due_date,
      observations
    });
    return res.status(201).json(loan);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.post('/api/loans/:id/return', requireAuth, asyncRoute(async (req, res) => {
  const { quantity, returned_date } = req.body || {};
  const loanId = Number(req.params.id);
  if (!Number.isSafeInteger(loanId) || loanId <= 0) {
    return res.status(400).json({ error: 'El identificador del préstamo no es válido.' });
  }
  if (quantity === undefined || quantity === null || quantity === '' || !returned_date) {
    return res.status(400).json({ error: 'La cantidad y la fecha real de devolución son obligatorias.' });
  }

  try {
    const loan = await registerReturn({
      loanId,
      quantity,
      returned_date,
      userId: req.user.id,
      isAdmin: req.user.role === 'admin'
    });
    return res.json(loan);
  } catch (error) {
    return respondWithError(res, error);
  }
}));

app.get('/api/history', requireAuth, asyncRoute(async (req, res) => {
  return res.json(await getHistory({ userId: req.user.id, isAdmin: req.user.role === 'admin' }));
}));

app.get('/api/reports/summary', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const dashboard = await getDashboardData();
  const resources = await getResources();
  return res.json({
    ...dashboard,
    inventorySummary: buildInventorySummary(resources),
    generatedAt: new Date().toISOString()
  });
}));

app.use('/api', (req, res) => {
  return res.status(404).json({ error: 'Ruta de API no encontrada.' });
});

app.get('*', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(`Error procesando ${req.method} ${req.path}:`, error);
  if (res.headersSent) return next(error);
  const status = error.statusCode || 500;
  return res.status(status).json({
    error: status >= 500 ? 'Error interno del servidor.' : error.message
  });
});

if (require.main === module) {
  ensureDatabaseInitialized()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Servidor iniciado en el puerto ${PORT}; Neon conectado.`);
      });
    })
    .catch((error) => {
      console.error('No se pudo inicializar Neon; el servidor no arrancará:', error.message);
      process.exitCode = 1;
    });
} else {
  module.exports = app;
}
