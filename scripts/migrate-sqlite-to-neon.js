require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { hashPassword, isPasswordHash } = require('../src/passwords');
const { createNeonPool } = require('../src/neonPool');

const arguments_ = process.argv.slice(2);
const applyChanges = arguments_.includes('--apply');
const migrationName = 'sqlite-app-db-to-neon-v1';
const sqlitePath = path.join(__dirname, '..', 'data', 'app.db');

if (arguments_.length > 1 || arguments_.some((argument) => !['--apply', '--dry-run'].includes(argument))) {
  throw new Error('Uso: node scripts/migrate-sqlite-to-neon.js [--dry-run|--apply]');
}

if (!process.env.DATABASE_URL) {
  throw new Error('Falta configurar DATABASE_URL para conectar con Neon/PostgreSQL.');
}

function asTimestamp(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha SQLite no válida: ${value}`);
  return date;
}

function computeResourceStatus(available, reserved, borrowed) {
  if (available === 0 && reserved + borrowed > 0) return 'agotado';
  if (available < 5) return 'bajo';
  return 'disponible';
}

async function runMigration() {
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const pool = createNeonPool({
    connectionTimeoutMillis: 10000
  });
  const counts = { users: 0, resources: 0, reservations: 0, loans: 0, history: 0 };
  const inventory = [];
  let client;

  try {
    client = await pool.connect();
    const source = Object.fromEntries(
      ['users', 'resources', 'reservations', 'loans', 'history']
        .map((table) => [table, sqlite.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()])
    );

    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationName]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS backend_data_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    const previous = await client.query('SELECT 1 FROM backend_data_migrations WHERE name = $1', [migrationName]);
    if (previous.rowCount) {
      await client.query('ROLLBACK');
      console.log('La migración ya se aplicó anteriormente; Neon no fue modificado.');
      return;
    }

    const userIds = new Map();
    for (const user of source.users) {
      const found = await client.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [user.username]);
      if (found.rowCount > 1) throw new Error('Hay usuarios duplicados por nombre en Neon; se cancela la migración.');

      if (found.rowCount === 1) {
        userIds.set(user.id, found.rows[0].id);
        continue;
      }

      const password = isPasswordHash(user.password) ? user.password : await hashPassword(user.password);
      const inserted = await client.query(
        `INSERT INTO users (name, username, password, role, created_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
         RETURNING id`,
        [user.name, user.username, password, user.role, asTimestamp(user.created_at)]
      );
      userIds.set(user.id, inserted.rows[0].id);
      counts.users += 1;
    }

    for (const resource of source.resources) {
      const existing = await client.query('SELECT id FROM resources WHERE resource_type = $1', [resource.resource_type]);
      if (existing.rowCount) continue;

      await client.query(
        `INSERT INTO resources
           (resource_type, name, total_quantity, available_quantity, reserved_quantity, borrowed_quantity, returned_quantity, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))`,
        [
          resource.resource_type,
          resource.name,
          resource.total_quantity,
          resource.available_quantity,
          resource.reserved_quantity,
          resource.borrowed_quantity,
          resource.returned_quantity,
          resource.status,
          asTimestamp(resource.updated_at)
        ]
      );
      counts.resources += 1;
    }

    for (const reservation of source.reservations) {
      const userId = userIds.get(reservation.user_id);
      if (!userId) throw new Error(`No se pudo relacionar el usuario de la reserva local ${reservation.id}.`);
      const values = [
        userId,
        reservation.resource_type,
        reservation.quantity,
        reservation.reserved_date,
        reservation.start_time,
        reservation.end_time,
        reservation.status,
        reservation.observations,
        asTimestamp(reservation.created_at)
      ];
      const exists = await client.query(
        `SELECT 1 FROM reservations
         WHERE user_id = $1 AND resource_type = $2 AND quantity = $3 AND reserved_date = $4::date
           AND start_time IS NOT DISTINCT FROM $5::time
           AND end_time IS NOT DISTINCT FROM $6::time
           AND status = $7 AND observations IS NOT DISTINCT FROM $8::text
           AND created_at = $9::timestamptz`,
        values
      );
      if (exists.rowCount) continue;

      await client.query(
        `INSERT INTO reservations
           (user_id, resource_type, quantity, reserved_date, start_time, end_time, status, observations, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))`,
        values
      );
      counts.reservations += 1;
    }

    for (const loan of source.loans) {
      const userId = userIds.get(loan.user_id);
      if (!userId) throw new Error(`No se pudo relacionar el usuario del préstamo local ${loan.id}.`);
      const values = [
        userId,
        loan.resource_type,
        loan.quantity,
        loan.loan_date,
        loan.due_date,
        loan.status,
        loan.returned_quantity,
        loan.observations,
        asTimestamp(loan.created_at)
      ];
      const exists = await client.query(
        `SELECT 1 FROM loans
         WHERE user_id = $1 AND resource_type = $2 AND quantity = $3 AND loan_date = $4::date AND due_date = $5::date
           AND status = $6 AND returned_quantity = $7
           AND observations IS NOT DISTINCT FROM $8::text
           AND created_at = $9::timestamptz`,
        values
      );
      if (exists.rowCount) continue;

      await client.query(
        `INSERT INTO loans
           (user_id, resource_type, quantity, loan_date, due_date, status, returned_quantity, observations, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))`,
        values
      );
      counts.loans += 1;
    }

    for (const entry of source.history) {
      const userId = entry.user_id === null ? null : userIds.get(entry.user_id);
      if (entry.user_id !== null && !userId) {
        throw new Error(`No se pudo relacionar el usuario del movimiento local ${entry.id}.`);
      }
      const values = [
        userId,
        entry.resource_type,
        entry.quantity,
        entry.operation_type,
        entry.state_before,
        entry.state_after,
        entry.details,
        asTimestamp(entry.created_at)
      ];
      const exists = await client.query(
        `SELECT 1 FROM history
         WHERE user_id IS NOT DISTINCT FROM $1::integer
           AND resource_type IS NOT DISTINCT FROM $2::text AND quantity = $3 AND operation_type = $4
           AND state_before IS NOT DISTINCT FROM $5::text AND state_after IS NOT DISTINCT FROM $6::text
           AND details IS NOT DISTINCT FROM $7::text AND created_at = $8::timestamptz`,
        values
      );
      if (exists.rowCount) continue;

      await client.query(
        `INSERT INTO history
           (user_id, resource_type, quantity, operation_type, state_before, state_after, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))`,
        values
      );
      counts.history += 1;
    }

    const inventoryRows = await client.query(
      'SELECT resource_type, total_quantity FROM resources ORDER BY resource_type'
    );
    for (const resource of inventoryRows.rows) {
      const reservations = await client.query(
        "SELECT COALESCE(SUM(quantity), 0)::int AS quantity FROM reservations WHERE resource_type = $1 AND status IN ('pendiente','confirmada')",
        [resource.resource_type]
      );
      const loans = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN status IN ('pendiente','activo','parcialmente_devuelto','vencido') THEN quantity - returned_quantity ELSE 0 END), 0)::int AS quantity, COALESCE(SUM(returned_quantity), 0)::int AS returned FROM loans WHERE resource_type = $1",
        [resource.resource_type]
      );
      const reserved = reservations.rows[0].quantity;
      const borrowed = loans.rows[0].quantity;
      const available = resource.total_quantity - reserved - borrowed;
      if (available < 0) {
        throw new Error(`Las reservas y préstamos superan el inventario disponible de ${resource.resource_type}; no se aplicó ningún cambio.`);
      }

      await client.query(
        `UPDATE resources
         SET reserved_quantity = $1, borrowed_quantity = $2, returned_quantity = $3,
             available_quantity = $4, status = $5, updated_at = NOW()
         WHERE resource_type = $6`,
        [reserved, borrowed, loans.rows[0].returned, available, computeResourceStatus(available, reserved, borrowed), resource.resource_type]
      );
      inventory.push({ resource_type: resource.resource_type, total: resource.total_quantity, reserved, borrowed, available });
    }

    await client.query(
      'INSERT INTO backend_data_migrations (name, details) VALUES ($1, $2::jsonb)',
      [migrationName, JSON.stringify({ counts, inventory })]
    );

    if (applyChanges) {
      await client.query('COMMIT');
      console.log('Migración aplicada a Neon:', JSON.stringify({ counts, inventory }));
    } else {
      await client.query('ROLLBACK');
      console.log('Simulación completada; Neon no fue modificado:', JSON.stringify({ counts, inventory }));
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('No se pudo revertir la migración:', rollbackError.message);
    }
    throw error;
  } finally {
    if (client) client.release();
    sqlite.close();
    await pool.end();
  }
}

runMigration().catch((error) => {
  console.error('Migración detenida sin aplicar cambios:', error.message);
  process.exitCode = 1;
});
