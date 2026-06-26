const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const LIVE_API_KEY = 'px_live_03752dd30078482b815d878e551c67bc';
const LIVE_WEBHOOK_SECRET = 'whsec_live_e7bcdfbd5de24883a17a00f4318cc90f';
const PAYX_BASE = 'https://payx.company/api/v1';

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── In-memory transaction store ──────────────────────────────────────────────
// Stores { status, errorMessage, transactionId, amount, phoneNumber, network, name, createdAt }
const transactionStore = new Map();

// Clean up entries older than 30 minutes to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, entry] of transactionStore.entries()) {
    if (entry.createdAt < cutoff) transactionStore.delete(id);
  }
}, 5 * 60 * 1000);

// ── Phone sanitizer (Ghana, always 12 digits: 233 + 9 local) ─────────────────
function sanitizeGhanaPhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('233')) digits = digits.substring(3);
  if (digits.startsWith('0'))   digits = digits.substring(1);
  digits = digits.substring(0, 9);
  return '233' + digits;
}

// ── Receipt builder ───────────────────────────────────────────────────────────
function buildReceipt(transactionId, amount, phoneNumber, name, network, status, errorMessage) {
  const now = new Date();
  return {
    receiptNumber: `RCP-${transactionId ? transactionId.slice(0, 8).toUpperCase() : Date.now()}`,
    transactionId: transactionId || null,
    status,
    date: now.toLocaleDateString('en-GH', { year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    customer: { name: name || 'N/A', phoneNumber, network },
    payment: { amount: parseFloat(amount).toFixed(2), currency: 'GHS', method: 'Mobile Money' },
    error: errorMessage || null,
  };
}

// ── POST /charge ──────────────────────────────────────────────────────────────
app.post('/charge', async (req, res) => {
  const { amount, phoneNumber, network, name } = req.body;

  if (!amount || !phoneNumber || !network) {
    return res.status(400).json({
      success: false,
      error: 'amount, phoneNumber, and network are required.',
      receipt: buildReceipt(null, amount, phoneNumber, name, network, 'FAILED', 'Missing required fields'),
    });
  }

  // Always send a clean 12-digit Ghana number to PayX
  const cleanPhone = sanitizeGhanaPhone(phoneNumber);

  let rawResponse, responseText;

  try {
    rawResponse = await fetch(`${PAYX_BASE}/charge`, {
      method: 'POST',
      headers: {
        'x-api-key': LIVE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        amount: parseFloat(amount),
        currency: 'GHS',
        phoneNumber: cleanPhone,
        network: network.toUpperCase(),
        payerMessage: `Loan fee payment from ${name || cleanPhone}`,
        payeeNote: `Fee - ${name || cleanPhone}`,
      }),
    });

    responseText = await rawResponse.text();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Network error reaching PayX: ${err.message}`,
      receipt: buildReceipt(null, amount, cleanPhone, name, network, 'FAILED', err.message),
    });
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    return res.status(502).json({
      success: false,
      error: `PayX returned an unexpected response (HTTP ${rawResponse.status}): ${responseText.slice(0, 300)}`,
      receipt: buildReceipt(null, amount, cleanPhone, name, network, 'FAILED', 'Unexpected PayX response'),
    });
  }

  if (!rawResponse.ok) {
    const errorMessage = data?.message || data?.error || `PayX error (HTTP ${rawResponse.status})`;
    return res.status(rawResponse.status).json({
      success: false,
      error: errorMessage,
      details: data,
      receipt: buildReceipt(null, amount, cleanPhone, name, network, 'FAILED', errorMessage),
    });
  }

  // STK push was accepted — status is PENDING until webhook confirms
  const transactionId = data.transactionId || data.transaction_id || data.id;

  if (transactionId) {
    transactionStore.set(transactionId, {
      status: 'PENDING',
      errorMessage: null,
      transactionId,
      amount,
      phoneNumber: cleanPhone,
      network,
      name,
      createdAt: Date.now(),
    });
  }

  return res.status(202).json({
    success: true,
    pending: true,
    message: data.message || 'STK push sent. Please check your phone and enter your PIN.',
    transactionId,
    status: 'PENDING',
    receipt: buildReceipt(transactionId, amount, cleanPhone, name, network, 'PENDING', null),
  });
});

// ── GET /status/:transactionId ────────────────────────────────────────────────
// Frontend polls this every few seconds after charge initiation
app.get('/status/:transactionId', async (req, res) => {
  const { transactionId } = req.params;
  const stored = transactionStore.get(transactionId);

  // If we have a webhook-confirmed status, return it immediately
  if (stored && stored.status !== 'PENDING') {
    return res.json({
      transactionId,
      status: stored.status,
      errorMessage: stored.errorMessage || null,
      receipt: buildReceipt(transactionId, stored.amount, stored.phoneNumber, stored.name, stored.network, stored.status, stored.errorMessage),
    });
  }

  // Otherwise ask PayX directly for the latest status
  try {
    const rawResponse = await fetch(`${PAYX_BASE}/transactions/${transactionId}`, {
      method: 'GET',
      headers: {
        'x-api-key': LIVE_API_KEY,
        'Accept': 'application/json',
      },
    });

    const responseText = await rawResponse.text();
    let data;
    try { data = JSON.parse(responseText); } catch { data = null; }

    if (!rawResponse.ok || !data) {
      // PayX status endpoint may not exist — return PENDING and wait for webhook
      return res.json({ transactionId, status: 'PENDING', errorMessage: null });
    }

    const payxStatus = (data.status || '').toUpperCase();
    const mappedStatus =
      payxStatus === 'SUCCESSFUL' || payxStatus === 'SUCCESS' || payxStatus === 'COMPLETED' ? 'SUCCESSFUL' :
      payxStatus === 'FAILED'     || payxStatus === 'CANCELLED' || payxStatus === 'REJECTED' ? 'FAILED' :
      'PENDING';

    const errorMsg = mappedStatus === 'FAILED'
      ? (data.message || data.error || data.reason || 'Payment failed or was cancelled by user')
      : null;

    // Update store
    if (stored) {
      stored.status = mappedStatus;
      stored.errorMessage = errorMsg;
    }

    return res.json({
      transactionId,
      status: mappedStatus,
      errorMessage: errorMsg,
      receipt: buildReceipt(
        transactionId,
        stored?.amount || 0,
        stored?.phoneNumber || '',
        stored?.name || '',
        stored?.network || '',
        mappedStatus,
        errorMsg
      ),
    });
  } catch (err) {
    return res.json({ transactionId, status: 'PENDING', errorMessage: null });
  }
});

// ── POST /webhooks ────────────────────────────────────────────────────────────
app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-payx-signature'];

  if (!signature) return res.status(401).json({ error: 'Missing x-payx-signature header.' });

  const body = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', LIVE_WEBHOOK_SECRET).update(body).digest('hex');

  if (signature !== expected) return res.status(401).json({ error: 'Invalid webhook signature.' });

  let event;
  try { event = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); }

  console.log('Webhook event:', event.event, '| tx:', event.data?.transactionId || event.data?.id);

  // Update transaction store from webhook
  const txId = event.data?.transactionId || event.data?.id;
  if (txId && transactionStore.has(txId)) {
    const entry = transactionStore.get(txId);
    const rawStatus = (event.data?.status || event.event || '').toUpperCase();
    entry.status =
      rawStatus.includes('SUCCESS') || rawStatus.includes('COMPLETE') ? 'SUCCESSFUL' :
      rawStatus.includes('FAIL') || rawStatus.includes('CANCEL') || rawStatus.includes('REJECT') ? 'FAILED' :
      'PENDING';
    entry.errorMessage = entry.status === 'FAILED'
      ? (event.data?.message || event.data?.reason || 'Payment failed')
      : null;
  }

  res.status(200).json({ received: true });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`PayX server running on port ${PORT}`));
