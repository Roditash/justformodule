const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEY_LENGTH, (error, derivedKey) => {
      if (error) return reject(error);
      return resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, storedPassword) {
  if (typeof storedPassword !== 'string') return false;

  if (!storedPassword.startsWith('scrypt$')) {
    const candidate = crypto.createHash('sha256').update(String(password)).digest();
    const stored = crypto.createHash('sha256').update(storedPassword).digest();
    return crypto.timingSafeEqual(candidate, stored);
  }

  const [, salt, expectedHex] = storedPassword.split('$');
  if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false;

  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEY_LENGTH, (error, key) => {
      if (error) return reject(error);
      return resolve(key);
    });
  });

  return crypto.timingSafeEqual(derivedKey, Buffer.from(expectedHex, 'hex'));
}

function isPasswordHash(password) {
  return typeof password === 'string' && /^scrypt\$[^$]+\$[a-f0-9]{128}$/i.test(password);
}

module.exports = { hashPassword, verifyPassword, isPasswordHash };
