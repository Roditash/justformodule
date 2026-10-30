const { Pool } = require('pg');

function verifiedConnectionString(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('Falta configurar DATABASE_URL para conectar con Neon/PostgreSQL.');
  }

  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL debe usar el protocolo PostgreSQL.');
  }
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

function createNeonPool(options = {}) {
  return new Pool({
    connectionString: verifiedConnectionString(process.env.DATABASE_URL),
    ssl: { rejectUnauthorized: true },
    ...options
  });
}

module.exports = { createNeonPool, verifiedConnectionString };
