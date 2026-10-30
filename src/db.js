require('dotenv').config();
const crypto = require('crypto');
const { hashPassword, verifyPassword, isPasswordHash } = require('./passwords');
const { createNeonPool } = require('./neonPool');

const configuredPoolSize = Number(process.env.PG_POOL_MAX);
const pool = createNeonPool({
  max: Number.isSafeInteger(configuredPoolSize) && configuredPoolSize > 0 ? configuredPoolSize : 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

pool.on('error', (error) => {
  console.error('Error inesperado en una conexión inactiva de PostgreSQL:', error.message);
});

async function withTransaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('No se pudo revertir la transacción:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function computeResourceStatus(availableQuantity, reservedQuantity, borrowedQuantity) {
  const totalInUse = reservedQuantity + borrowedQuantity;
  if (availableQuantity <= 0 && totalInUse > 0) return 'agotado';
  if (availableQuantity < 5) return 'bajo';
  return 'disponible';
}

function ensureNumeric(value, fieldName) {
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue < 0 || numericValue > 2147483647) {
    throw new Error(`${fieldName} no puede ser negativo o no válido.`);
  }
  return numericValue;
}

function ensureDate(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} debe tener formato AAAA-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} no es una fecha válida.`);
  }
  return value;
}

function ensureTime(value, fieldName) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value)) {
    throw new Error(`${fieldName} debe tener formato HH:MM.`);
  }
  return value;
}

function timeInSeconds(value) {
  if (!value) return null;
  const [hours, minutes, seconds = '0'] = value.split(':');
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function ensureOptionalText(value, fieldName, maxLength = 5000) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${fieldName} debe ser texto de hasta ${maxLength} caracteres.`);
  }
  return value.trim() || null;
}

async function initializeDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Falta configurar DATABASE_URL para conectar con Neon/PostgreSQL.');
  }

  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['inventario-backend-schema-v1']);
    await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin','user')) DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);

    CREATE TABLE IF NOT EXISTS resources (
      id SERIAL PRIMARY KEY,
      resource_type VARCHAR(20) UNIQUE NOT NULL CHECK (resource_type IN ('mesa','silla')),
      name VARCHAR(255) NOT NULL,
      total_quantity INTEGER NOT NULL,
      available_quantity INTEGER NOT NULL,
      reserved_quantity INTEGER NOT NULL DEFAULT 0,
      borrowed_quantity INTEGER NOT NULL DEFAULT 0,
      returned_quantity INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'disponible',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      resource_type VARCHAR(20) NOT NULL,
      quantity INTEGER NOT NULL,
      reserved_date DATE NOT NULL,
      start_time TIME,
      end_time TIME,
      status VARCHAR(30) NOT NULL CHECK (status IN ('pendiente','confirmada','cancelada','finalizada')) DEFAULT 'pendiente',
      observations TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS loans (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      resource_type VARCHAR(20) NOT NULL,
      quantity INTEGER NOT NULL,
      loan_date DATE NOT NULL,
      due_date DATE NOT NULL,
      status VARCHAR(30) NOT NULL CHECK (status IN ('pendiente','activo','parcialmente_devuelto','devuelto','vencido')) DEFAULT 'pendiente',
      returned_quantity INTEGER NOT NULL DEFAULT 0,
      observations TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      resource_type VARCHAR(20),
      quantity INTEGER NOT NULL,
      operation_type VARCHAR(50) NOT NULL,
      state_before VARCHAR(255),
      state_after VARCHAR(255),
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `);

    const userCount = await client.query('SELECT COUNT(*)::int AS count FROM users');
    if (userCount.rows[0].count === 0) {
      if (process.env.NODE_ENV === 'production') {
        const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD;
        if (typeof initialAdminPassword !== 'string' || initialAdminPassword.length < 12) {
          throw new Error('Configura INITIAL_ADMIN_PASSWORD (mínimo 12 caracteres) para inicializar usuarios en producción.');
        }
        const initialAdminUsername = process.env.INITIAL_ADMIN_USERNAME || 'admin';
        await client.query(
          'INSERT INTO users (name, username, password, role) VALUES ($1, $2, $3, $4)',
          ['Administrador', initialAdminUsername, await hashPassword(initialAdminPassword), 'admin']
        );
      } else {
        const adminPassword = await hashPassword('admin123');
        const userPassword = await hashPassword('usuario123');
        await client.query(`
          INSERT INTO users (name, username, password, role)
          VALUES ($1, 'admin', $2, 'admin'), ($3, 'usuario', $4, 'user')
        `, ['Administrador', adminPassword, 'Usuario', userPassword]);
      }
    }

    const resourceCount = await client.query('SELECT COUNT(*)::int AS count FROM resources');
    if (resourceCount.rows[0].count === 0) {
      await client.query(`
        INSERT INTO resources (resource_type, name, total_quantity, available_quantity, reserved_quantity, borrowed_quantity, returned_quantity, status)
        VALUES
          ('mesa', 'Mesa', 20, 20, 0, 0, 0, 'disponible'),
          ('silla', 'Silla', 100, 100, 0, 0, 0, 'disponible')
      `);
    }
  });
}

async function getUserByCredentials(username, password) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password))) return null;

  if (!isPasswordHash(user.password)) {
    const hashedPassword = await hashPassword(password);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
    user.password = hashedPassword;
  }
  return user;
}

async function getUserById(id, client = pool) {
  const result = await client.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function registerSession(token, userId, expiresAt) {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM user_sessions WHERE expires_at < NOW() OR revoked_at < NOW() - INTERVAL '30 days'");
    await client.query(
      'INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), userId, expiresAt]
    );
  });
}

async function isSessionActive(token) {
  const result = await pool.query(
    'SELECT 1 FROM user_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()',
    [hashToken(token)]
  );
  return result.rowCount > 0;
}

async function clearSession(token) {
  await pool.query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)]
  );
}

async function listUsers() {
  const result = await pool.query('SELECT id, name, username, role FROM users ORDER BY id');
  return result.rows;
}

async function createUser({ name, username, password, role }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 255) {
    throw new Error('El nombre debe contener entre 1 y 255 caracteres.');
  }
  if (typeof username !== 'string' || !username.trim() || username.trim().length > 255) {
    throw new Error('El nombre de usuario debe contener entre 1 y 255 caracteres.');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    throw new Error('La contraseña debe contener entre 8 y 1024 caracteres.');
  }
  if (!['admin', 'user'].includes(role)) {
    throw new Error('El rol debe ser admin o user.');
  }
  const normalizedRole = role;
  const hashedPassword = await hashPassword(password);
  try {
    const result = await pool.query(
      'INSERT INTO users (name, username, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, username, role',
      [name.trim(), username.trim(), hashedPassword, normalizedRole]
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw new Error('El nombre de usuario ya existe.');
    }
    throw error;
  }
}

async function getResourceByType(resourceType, client = pool, lock = false) {
  const normalizedType = String(resourceType).trim().toLowerCase();
  const result = await client.query(
    `SELECT * FROM resources WHERE resource_type = $1${lock ? ' FOR UPDATE' : ''}`,
    [normalizedType]
  );
  const resource = result.rows[0];
  if (!resource) {
    throw new Error('El tipo de recurso no existe.');
  }

  const availableQuantity = resource.total_quantity - resource.reserved_quantity - resource.borrowed_quantity;
  const status = computeResourceStatus(availableQuantity, resource.reserved_quantity, resource.borrowed_quantity);

  return { ...resource, available_quantity: availableQuantity, status };
}

async function getResources() {
  const result = await pool.query('SELECT * FROM resources ORDER BY resource_type');
  return result.rows.map((resource) => {
    const availableQuantity = resource.total_quantity - resource.reserved_quantity - resource.borrowed_quantity;
    return {
      ...resource,
      available_quantity: availableQuantity,
      status: computeResourceStatus(availableQuantity, resource.reserved_quantity, resource.borrowed_quantity)
    };
  });
}

async function createHistory({ userId, resourceType, quantity, operationType, stateBefore, stateAfter, details, client = pool }) {
  await client.query(
    'INSERT INTO history (user_id, resource_type, quantity, operation_type, state_before, state_after, details) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId || null, resourceType || null, quantity, operationType, stateBefore || null, stateAfter || null, details || null]
  );
}

async function createResource({ resource_type, total_quantity, name, userId }) {
  const normalizedType = String(resource_type).trim().toLowerCase();
  const total = ensureNumeric(total_quantity, 'Cantidad total');
  const resourceName = ensureOptionalText(name, 'El nombre del recurso', 255);
  if (!['mesa', 'silla'].includes(normalizedType)) {
    throw new Error('El tipo de recurso debe ser mesa o silla.');
  }

  const resource = {
    resource_type: normalizedType,
    name: resourceName || (normalizedType === 'mesa' ? 'Mesa' : 'Silla'),
    total_quantity: total,
    available_quantity: total,
    reserved_quantity: 0,
    borrowed_quantity: 0,
    returned_quantity: 0,
    status: computeResourceStatus(total, 0, 0)
  };

  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO resources (resource_type, name, total_quantity, available_quantity, reserved_quantity, borrowed_quantity, returned_quantity, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        resource.resource_type,
        resource.name,
        resource.total_quantity,
        resource.available_quantity,
        resource.reserved_quantity,
        resource.borrowed_quantity,
        resource.returned_quantity,
        resource.status
      ]
    );

    await createHistory({
      userId,
      resourceType: normalizedType,
      quantity: total,
      operationType: 'modificacion',
      stateBefore: 'nuevo',
      stateAfter: 'disponible',
      details: `Inventario inicial creado para ${resource.name}`,
      client
    });

    return { id: result.rows[0].id, ...resource };
  });
}

async function updateResource({ resource_type, total_quantity, status, userId }) {
  const normalizedType = String(resource_type).trim().toLowerCase();
  return withTransaction(async (client) => {
    const current = await getResourceByType(normalizedType, client, true);
    const newTotal = total_quantity === undefined || total_quantity === null
      ? current.total_quantity
      : ensureNumeric(total_quantity, 'Cantidad total');
    if (newTotal < current.reserved_quantity + current.borrowed_quantity) {
      throw new Error('La cantidad total no puede ser menor a la cantidad reservada o prestada.');
    }

    const nextAvailable = newTotal - current.reserved_quantity - current.borrowed_quantity;
    const nextStatus = computeResourceStatus(nextAvailable, current.reserved_quantity, current.borrowed_quantity);
    if (status && status !== nextStatus) {
      throw new Error('El estado del inventario se calcula automáticamente a partir de las cantidades.');
    }

    await client.query(
      'UPDATE resources SET total_quantity = $1, available_quantity = $2, status = $3, updated_at = NOW() WHERE resource_type = $4',
      [newTotal, nextAvailable, nextStatus, normalizedType]
    );

    await createHistory({
      userId,
      resourceType: normalizedType,
      quantity: newTotal,
      operationType: 'modificacion',
      stateBefore: `${current.total_quantity} / ${current.available_quantity} / ${current.reserved_quantity} / ${current.borrowed_quantity}`,
      stateAfter: `${newTotal} / ${nextAvailable} / ${current.reserved_quantity} / ${current.borrowed_quantity}`,
      details: 'Actualización de inventario.',
      client
    });

    return {
      ...current,
      total_quantity: newTotal,
      available_quantity: nextAvailable,
      status: nextStatus
    };
  });
}

async function getDashboardData() {
  const resources = await getResources();
  const tables = resources.find((item) => item.resource_type === 'mesa') || { total_quantity: 0, available_quantity: 0, reserved_quantity: 0, borrowed_quantity: 0 };
  const chairs = resources.find((item) => item.resource_type === 'silla') || { total_quantity: 0, available_quantity: 0, reserved_quantity: 0, borrowed_quantity: 0 };

  const reservationStats = await pool.query(`
    SELECT COUNT(*)::int AS pending_reservations FROM reservations WHERE status IN ('pendiente','confirmada')
  `);

  const loanStats = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE quantity > returned_quantity AND due_date >= CURRENT_DATE
      )::int AS active_loans,
      COUNT(*) FILTER (
        WHERE quantity > returned_quantity AND due_date < CURRENT_DATE
      )::int AS overdue_loans,
      COUNT(*) FILTER (
        WHERE quantity > returned_quantity
      )::int AS pending_returns
    FROM loans
  `);

  return {
    totals: {
      total_tables: Number(tables.total_quantity || 0),
      available_tables: Number(tables.available_quantity || 0),
      reserved_tables: Number(tables.reserved_quantity || 0),
      borrowed_tables: Number(tables.borrowed_quantity || 0),
      total_chairs: Number(chairs.total_quantity || 0),
      available_chairs: Number(chairs.available_quantity || 0),
      reserved_chairs: Number(chairs.reserved_quantity || 0),
      borrowed_chairs: Number(chairs.borrowed_quantity || 0),
      pending_reservations: Number(reservationStats.rows[0].pending_reservations || 0),
      active_loans: Number(loanStats.rows[0].active_loans || 0),
      overdue_loans: Number(loanStats.rows[0].overdue_loans || 0),
      pending_returns: Number(loanStats.rows[0].pending_returns || 0)
    },
    resources
  };
}

async function getReservations({ userId, isAdmin = false } = {}) {
  const result = await pool.query(`
    SELECT r.*, u.name AS user_name, u.role AS user_role
    FROM reservations r
    JOIN users u ON u.id = r.user_id
    WHERE $1::boolean OR r.user_id = $2
    ORDER BY r.created_at DESC
  `, [isAdmin, userId || null]);
  return result.rows;
}

async function createReservation({ userId, resource_type, quantity, reserved_date, start_time, end_time, observations }) {
  const validReservedDate = ensureDate(reserved_date, 'La fecha de reserva');
  const validStartTime = ensureTime(start_time, 'La hora de inicio');
  const validEndTime = ensureTime(end_time, 'La hora de término');
  if (validStartTime && validEndTime && timeInSeconds(validEndTime) <= timeInSeconds(validStartTime)) {
    throw new Error('La hora de término debe ser posterior a la hora de inicio.');
  }
  const normalizedType = String(resource_type).trim().toLowerCase();
  const normalizedQuantity = ensureNumeric(quantity, 'Cantidad reservada');
  const normalizedObservations = ensureOptionalText(observations, 'Las observaciones');
  if (!['mesa', 'silla'].includes(normalizedType)) throw new Error('Tipo de recurso inválido.');
  if (normalizedQuantity <= 0) throw new Error('La cantidad de reserva debe ser mayor a cero.');

  return withTransaction(async (client) => {
    const user = await getUserById(userId, client);
    if (!user) throw new Error('Usuario no encontrado.');

    const resource = await getResourceByType(normalizedType, client, true);
    if (normalizedQuantity > resource.available_quantity) {
      throw new Error('No hay suficiente disponibilidad para realizar la reserva.');
    }

    const result = await client.query(
      `INSERT INTO reservations (user_id, resource_type, quantity, reserved_date, start_time, end_time, status, observations)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', $7)
       RETURNING id`,
      [user.id, normalizedType, normalizedQuantity, validReservedDate, validStartTime, validEndTime, normalizedObservations]
    );

    const nextReserved = resource.reserved_quantity + normalizedQuantity;
    const nextAvailable = resource.total_quantity - nextReserved - resource.borrowed_quantity;

    await client.query(
      'UPDATE resources SET reserved_quantity = $1, available_quantity = $2, status = $3, updated_at = NOW() WHERE resource_type = $4',
      [nextReserved, nextAvailable, computeResourceStatus(nextAvailable, nextReserved, resource.borrowed_quantity), normalizedType]
    );

    await createHistory({
      userId: user.id,
      resourceType: normalizedType,
      quantity: normalizedQuantity,
      operationType: 'reserva',
      stateBefore: `${resource.available_quantity}/${resource.reserved_quantity}/${resource.borrowed_quantity}`,
      stateAfter: `${nextAvailable}/${nextReserved}/${resource.borrowed_quantity}`,
      details: `Reserva creada para ${user.name}.`,
      client
    });

    return {
      id: result.rows[0].id,
      user_id: user.id,
      resource_type: normalizedType,
      quantity: normalizedQuantity,
      reserved_date: validReservedDate,
      start_time: validStartTime,
      end_time: validEndTime,
      status: 'pendiente',
      observations: normalizedObservations
    };
  });
}

async function confirmReservation({ reservationId, userId }) {
  return withTransaction(async (client) => {
    const reservationResult = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    const reservation = reservationResult.rows[0];
    if (!reservation) throw new Error('La reserva no existe.');
    if (reservation.status === 'confirmada') throw new Error('La reserva ya está confirmada.');
    if (reservation.status === 'cancelada') throw new Error('La reserva ya fue cancelada.');
    if (reservation.status === 'finalizada') throw new Error('La reserva ya fue finalizada.');

    await client.query('UPDATE reservations SET status = $1 WHERE id = $2', ['confirmada', reservationId]);
    await createHistory({
      userId,
      resourceType: reservation.resource_type,
      quantity: reservation.quantity,
      operationType: 'reserva',
      stateBefore: reservation.status,
      stateAfter: 'confirmada',
      details: 'Reserva confirmada.',
      client
    });

    return { ...reservation, status: 'confirmada' };
  });
}

async function cancelReservation({ reservationId, userId, isAdmin = false }) {
  return withTransaction(async (client) => {
    const reservationResult = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    const reservation = reservationResult.rows[0];
    if (!reservation) throw new Error('La reserva no existe.');
    if (!isAdmin && reservation.user_id !== userId) throw new Error('No tienes permiso para cancelar esta reserva.');
    if (reservation.status === 'cancelada') throw new Error('La reserva ya está cancelada.');
    if (reservation.status === 'finalizada') throw new Error('No se puede cancelar una reserva finalizada.');

    const resource = await getResourceByType(reservation.resource_type, client, true);
    const newReserved = resource.reserved_quantity - reservation.quantity;
    if (newReserved < 0) throw new Error('El inventario reservado no coincide con la reserva.');
    const nextAvailable = resource.total_quantity - newReserved - resource.borrowed_quantity;

    await client.query(
      'UPDATE resources SET reserved_quantity = $1, available_quantity = $2, status = $3, updated_at = NOW() WHERE resource_type = $4',
      [newReserved, nextAvailable, computeResourceStatus(nextAvailable, newReserved, resource.borrowed_quantity), reservation.resource_type]
    );

    await client.query('UPDATE reservations SET status = $1 WHERE id = $2', ['cancelada', reservationId]);

    await createHistory({
      userId,
      resourceType: reservation.resource_type,
      quantity: reservation.quantity,
      operationType: 'cancelacion',
      stateBefore: reservation.status,
      stateAfter: 'cancelada',
      details: `Reserva cancelada por ${userId}.`,
      client
    });

    return { ...reservation, status: 'cancelada' };
  });
}

async function getLoans({ userId, isAdmin = false } = {}) {
  const result = await pool.query(`
    SELECT l.id, l.user_id, l.resource_type, l.quantity, l.loan_date, l.due_date,
      CASE
        WHEN l.quantity > l.returned_quantity AND l.due_date < CURRENT_DATE THEN 'vencido'
        ELSE l.status
      END AS status,
      l.returned_quantity, l.observations, l.created_at,
      u.name AS user_name
    FROM loans l
    JOIN users u ON u.id = l.user_id
    WHERE $1::boolean OR l.user_id = $2
    ORDER BY l.created_at DESC
  `, [isAdmin, userId || null]);
  return result.rows;
}

async function createLoan({ userId, resource_type, quantity, loan_date, due_date, observations }) {
  const validLoanDate = ensureDate(loan_date, 'La fecha de préstamo');
  const validDueDate = ensureDate(due_date, 'La fecha de devolución');
  if (validDueDate < validLoanDate) {
    throw new Error('La fecha de devolución no puede ser anterior a la fecha del préstamo.');
  }
  const normalizedType = String(resource_type).trim().toLowerCase();
  const normalizedQuantity = ensureNumeric(quantity, 'Cantidad prestada');
  const normalizedObservations = ensureOptionalText(observations, 'Las observaciones');
  if (!['mesa', 'silla'].includes(normalizedType)) throw new Error('Tipo de recurso inválido.');
  if (normalizedQuantity <= 0) throw new Error('La cantidad del préstamo debe ser mayor a cero.');

  return withTransaction(async (client) => {
    const user = await getUserById(userId, client);
    if (!user) throw new Error('Usuario no encontrado.');

    const resource = await getResourceByType(normalizedType, client, true);
    if (normalizedQuantity > resource.available_quantity) {
      throw new Error('No hay suficientes recursos disponibles para registrar el préstamo.');
    }

    const updatedReserved = resource.reserved_quantity;
    const updatedBorrowed = resource.borrowed_quantity + normalizedQuantity;
    const updatedAvailable = resource.total_quantity - updatedReserved - updatedBorrowed;

    await client.query(
      'UPDATE resources SET reserved_quantity = $1, borrowed_quantity = $2, available_quantity = $3, status = $4, updated_at = NOW() WHERE resource_type = $5',
      [updatedReserved, updatedBorrowed, updatedAvailable, computeResourceStatus(updatedAvailable, updatedReserved, updatedBorrowed), normalizedType]
    );

    const result = await client.query(
      `INSERT INTO loans (user_id, resource_type, quantity, loan_date, due_date, status, returned_quantity, observations)
       VALUES ($1, $2, $3, $4, $5, 'activo', 0, $6)
       RETURNING id`,
      [user.id, normalizedType, normalizedQuantity, validLoanDate, validDueDate, normalizedObservations]
    );

    await createHistory({
      userId: user.id,
      resourceType: normalizedType,
      quantity: normalizedQuantity,
      operationType: 'prestamo',
      stateBefore: `${resource.available_quantity}/${resource.reserved_quantity}/${resource.borrowed_quantity}`,
      stateAfter: `${updatedAvailable}/${updatedReserved}/${updatedBorrowed}`,
      details: `Préstamo registrado para ${user.name}.`,
      client
    });

    return {
      id: result.rows[0].id,
      user_id: user.id,
      resource_type: normalizedType,
      quantity: normalizedQuantity,
      loan_date: validLoanDate,
      due_date: validDueDate,
      status: 'activo',
      returned_quantity: 0,
      observations: normalizedObservations
    };
  });
}

async function registerReturn({ loanId, quantity, returned_date, userId, isAdmin = false }) {
  const validReturnedDate = ensureDate(returned_date, 'La fecha de devolución');
  const normalizedQuantity = ensureNumeric(quantity, 'Cantidad devuelta');
  if (normalizedQuantity <= 0) throw new Error('La cantidad devuelta debe ser mayor a cero.');

  return withTransaction(async (client) => {
    const loanResult = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
    const loan = loanResult.rows[0];
    if (!loan) throw new Error('El préstamo no existe.');
    if (!isAdmin && loan.user_id !== userId) throw new Error('No tienes permiso para registrar esta devolución.');
    if (validReturnedDate < String(loan.loan_date).slice(0, 10)) {
      throw new Error('La fecha de devolución no puede ser anterior a la fecha del préstamo.');
    }

    const remainingQuantity = Number(loan.quantity) - Number(loan.returned_quantity);
    if (normalizedQuantity > remainingQuantity) {
      throw new Error('La cantidad devuelta supera la cantidad pendiente del préstamo.');
    }

    const resource = await getResourceByType(loan.resource_type, client, true);
    const nextReturnedQuantity = Number(loan.returned_quantity) + normalizedQuantity;
    const nextBorrowedQuantity = resource.borrowed_quantity - normalizedQuantity;
    if (nextBorrowedQuantity < 0) throw new Error('El inventario prestado no coincide con el préstamo.');
    const nextAvailable = resource.total_quantity - resource.reserved_quantity - nextBorrowedQuantity;

    await client.query(
      'UPDATE resources SET borrowed_quantity = $1, returned_quantity = returned_quantity + $2, available_quantity = $3, status = $4, updated_at = NOW() WHERE resource_type = $5',
      [nextBorrowedQuantity, normalizedQuantity, nextAvailable, computeResourceStatus(nextAvailable, resource.reserved_quantity, nextBorrowedQuantity), loan.resource_type]
    );

    let nextStatus = 'activo';
    if (nextReturnedQuantity === Number(loan.quantity)) {
      nextStatus = 'devuelto';
    } else if (nextReturnedQuantity > 0) {
      nextStatus = 'parcialmente_devuelto';
    }

    await client.query(
      'UPDATE loans SET returned_quantity = $1, status = $2 WHERE id = $3',
      [nextReturnedQuantity, nextStatus, loanId]
    );

    await createHistory({
      userId,
      resourceType: loan.resource_type,
      quantity: normalizedQuantity,
      operationType: normalizedQuantity === remainingQuantity ? 'devolucion' : 'devolucion_parcial',
      stateBefore: `${loan.status}/${loan.returned_quantity}`,
      stateAfter: `${nextStatus}/${nextReturnedQuantity}`,
      details: `Devolución registrada el ${validReturnedDate}.`,
      client
    });

    return { ...loan, returned_quantity: nextReturnedQuantity, status: nextStatus };
  });
}

async function getHistory({ userId, isAdmin = false } = {}) {
  const result = await pool.query(`
    SELECT h.*, u.name AS user_name
    FROM history h
    LEFT JOIN users u ON u.id = h.user_id
    WHERE $1::boolean OR h.user_id = $2
    ORDER BY h.created_at DESC
  `, [isAdmin, userId || null]);
  return result.rows;
}

module.exports = {
  initializeDb,
  db: pool,
  getUserByCredentials,
  getUserById,
  registerSession,
  isSessionActive,
  clearSession,
  listUsers,
  createUser,
  getResources,
  getResourceByType,
  createResource,
  updateResource,
  getDashboardData,
  getReservations,
  createReservation,
  confirmReservation,
  cancelReservation,
  getLoans,
  createLoan,
  registerReturn,
  getHistory
};
