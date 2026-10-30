const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, isPasswordHash, verifyPassword } = require('../src/passwords');
const { verifiedConnectionString } = require('../src/neonPool');

test('passwords are stored as scrypt hashes and can be verified', async () => {
  const hashed = await hashPassword('a-strong-password');

  assert.notEqual(hashed, 'a-strong-password');
  assert.equal(isPasswordHash(hashed), true);
  assert.equal(await verifyPassword('a-strong-password', hashed), true);
  assert.equal(await verifyPassword('wrong-password', hashed), false);
});

test('legacy plaintext passwords can be verified for automatic upgrade', async () => {
  assert.equal(await verifyPassword('legacy-password', 'legacy-password'), true);
  assert.equal(await verifyPassword('wrong-password', 'legacy-password'), false);
  assert.equal(isPasswordHash('legacy-password'), false);
});

test('malformed scrypt values never authenticate', async () => {
  assert.equal(await verifyPassword('password', 'scrypt$broken$value'), false);
});

test('Neon URLs always request full TLS certificate verification', () => {
  const connectionString = verifiedConnectionString(
    'postgresql://user:pass@ep.example.neon.tech/db?sslmode=require&channel_binding=require'
  );
  const url = new URL(connectionString);

  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.equal(url.searchParams.get('channel_binding'), 'require');
});
