const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaypalDemoOrder, getPaypalSandboxConfig, validateDemoAmount } = require('../src/paypal');

test('PayPal configuration is unavailable unless both Sandbox credentials exist', () => {
  const previousClientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const previousClientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;

  try {
    delete process.env.PAYPAL_SANDBOX_CLIENT_ID;
    delete process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
    assert.deepEqual(getPaypalSandboxConfig(), {
      configured: false,
      clientId: null,
      environment: 'sandbox'
    });
  } finally {
    if (previousClientId === undefined) delete process.env.PAYPAL_SANDBOX_CLIENT_ID;
    else process.env.PAYPAL_SANDBOX_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
    else process.env.PAYPAL_SANDBOX_CLIENT_SECRET = previousClientSecret;
  }
});

test('demo amounts are limited to valid USD values with two decimals and a $1000 cap', () => {
  assert.equal(validateDemoAmount('10'), '10.00');
  assert.equal(validateDemoAmount('0.01'), '0.01');
  assert.equal(validateDemoAmount('1000.00'), '1000.00');
  for (const amount of ['0', '1000.01', '-1', '1.001', '1e2', 'abc']) {
    assert.throws(() => validateDemoAmount(amount), { statusCode: 400 });
  }
});

test('demo order requests use only PayPal Sandbox and never capture the order', async () => {
  const previousClientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const previousClientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  const previousFetch = global.fetch;
  const requests = [];

  process.env.PAYPAL_SANDBOX_CLIENT_ID = 'sandbox-client';
  process.env.PAYPAL_SANDBOX_CLIENT_SECRET = 'sandbox-secret';
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? { ok: true, json: async () => ({ access_token: 'sandbox-token' }) }
      : { ok: true, json: async () => ({ id: 'SANDBOX-ORDER-123', status: 'CREATED' }) };
  };

  try {
    assert.deepEqual(await createPaypalDemoOrder('10.00'), { id: 'SANDBOX-ORDER-123' });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ url }) => url.startsWith('https://api-m.sandbox.paypal.com/')));
    assert.equal(requests[1].url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
    assert.equal(JSON.parse(requests[1].options.body).purchase_units[0].amount.value, '10.00');
    assert.equal(requests.some(({ url }) => url.includes('/capture')), false);
  } finally {
    global.fetch = previousFetch;
    if (previousClientId === undefined) delete process.env.PAYPAL_SANDBOX_CLIENT_ID;
    else process.env.PAYPAL_SANDBOX_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
    else process.env.PAYPAL_SANDBOX_CLIENT_SECRET = previousClientSecret;
  }
});
