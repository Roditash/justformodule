const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

class PaypalSandboxError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getPaypalSandboxConfig() {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();

  return {
    configured: Boolean(clientId && clientSecret),
    clientId: clientId && clientSecret ? clientId : null,
    environment: 'sandbox'
  };
}

function requirePaypalSandboxCredentials() {
  const { configured } = getPaypalSandboxConfig();
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();
  if (!configured || !clientSecret) {
    throw new PaypalSandboxError('PayPal Sandbox no está configurado en el servidor.', 503);
  }

  return {
    clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID.trim(),
    clientSecret
  };
}

function validateDemoAmount(value) {
  if (typeof value !== 'string' || !/^\d{1,4}(?:\.\d{1,2})?$/.test(value)) {
    throw new PaypalSandboxError('El importe debe ser un número válido con hasta dos decimales.', 400);
  }

  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000) {
    throw new PaypalSandboxError('El importe de demostración debe estar entre 0.01 y 1000 USD.', 400);
  }

  return amount.toFixed(2);
}

async function paypalSandboxRequest(path, options) {
  let response;
  try {
    response = await fetch(`${PAYPAL_SANDBOX_API}${path}`, options);
  } catch (error) {
    throw new PaypalSandboxError('No se pudo conectar con PayPal Sandbox.', 502);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new PaypalSandboxError('PayPal Sandbox devolvió una respuesta no válida.', 502);
  }

  if (!response.ok) {
    console.error('PayPal Sandbox respondió con estado HTTP:', response.status);
    throw new PaypalSandboxError('PayPal Sandbox rechazó la solicitud.', 502);
  }

  return data;
}

async function createPaypalDemoOrder(amountValue) {
  const amount = validateDemoAmount(amountValue);
  const { clientId, clientSecret } = requirePaypalSandboxCredentials();
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const token = await paypalSandboxRequest('/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new PaypalSandboxError('PayPal Sandbox no proporcionó un token válido.', 502);
  }

  const order = await paypalSandboxRequest('/v2/checkout/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: amount },
        description: 'Orden de demostración: no se capturará ningún pago'
      }]
    })
  });

  if (typeof order.id !== 'string' || order.status !== 'CREATED') {
    throw new PaypalSandboxError('PayPal Sandbox no creó una orden válida.', 502);
  }

  return { id: order.id };
}

module.exports = { createPaypalDemoOrder, getPaypalSandboxConfig, validateDemoAmount };
