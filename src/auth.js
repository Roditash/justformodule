const jwt = require('jsonwebtoken');
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('Falta configurar JWT_SECRET en producción.');
}

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET debe tener al menos 32 caracteres.');
}

function createToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function verifyToken(token) {
  if (!token) {
    throw new Error('Token no proporcionado.');
  }

  return jwt.verify(token, JWT_SECRET);
}

function extractTokenFromRequest(req) {
  const header = req.headers.authorization || req.headers['x-auth-token'];
  if (!header) return null;
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

module.exports = {
  createToken,
  verifyToken,
  extractTokenFromRequest
};
