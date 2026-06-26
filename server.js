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

function generateReceipt(transactionId, amount, phoneNumber, name, network, status, errorMessage) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-GH', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return {
    receipt: {
      receiptNumber: `RCP-${transactionId ? transactionId.slice(0, 8).toUpperCase() : Date.now()}`,
      transactionId: transactionId || null,
      status: status,
      date: dateStr,
      time: timeStr,
      customer: {
        name: name || 'N/A',
        phoneNumber: phoneNumber,
        network: network,
      },
      payment: {
        amount: parseFloat(amount).toFixed(2),
        currency: 'GHS',
        method: 'Mobile Money',
      },
      error: errorMessage || null,
    },
  };
}

app.post('/charge', async (req, res) => {
  const { amount, phoneNumber, network, name } = req.body;

  if (!amount || !phoneNumber || !network) {
    return res.status(400).json({
      success: false,
      error: 'amount, phoneNumber, and network are required.',
      receipt: generateReceipt(null, amount, phoneNumber, name, network, 'FAILED', 'amount, phoneNumber, and network are required.').receipt,
    });
  }

  let rawResponse;
  let responseText;

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
        phoneNumber: phoneNumber,
        network: network.toUpperCase(),
        payerMessage: `Payment from ${name || phoneNumber}`,
        payeeNote: `Deposit - ${name || phoneNumber}`,
      }),
    });

    responseText = await rawResponse.text();

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      return res.status(rawResponse.status || 502).json({
        success: false,
        error: `PayX returned an unexpected response (HTTP ${rawResponse.status}): ${responseText.slice(0, 300)}`,
        receipt: generateReceipt(null, amount, phoneNumber, name, network, 'FAILED',
          `PayX returned an unexpected response (HTTP ${rawResponse.status})`).receipt,
      });
    }

    if (!rawResponse.ok) {
      const errorMessage = data?.message || data?.error || `PayX error (HTTP ${rawResponse.status})`;
      return res.status(rawResponse.status).json({
        success: false,
        error: errorMessage,
        details: data,
        receipt: generateReceipt(null, amount, phoneNumber, name, network, 'FAILED', errorMessage).receipt,
      });
    }

    const receipt = generateReceipt(
      data.transactionId,
      amount,
      phoneNumber,
      name,
      network,
      data.status || 'PENDING',
      null
    );

    return res.status(202).json({
      success: true,
      message: data.message || 'Transaction initiated. Check your phone for the USSD prompt.',
      transactionId: data.transactionId,
      status: data.status || 'PENDING',
      ...receipt,
    });

  } catch (err) {
    const errorMessage = err.message || 'Network error contacting PayX.';
    return res.status(500).json({
      success: false,
      error: errorMessage,
      receipt: generateReceipt(null, amount, phoneNumber, name, network, 'FAILED', errorMessage).receipt,
    });
  }
});

app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-payx-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing x-payx-signature header.' });
  }

  const body = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);

  const expected = crypto
    .createHmac('sha256', LIVE_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expected) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON in webhook body.' });
  }

  console.log('Webhook event received:', event.event);
  console.log('Transaction data:', JSON.stringify(event.data, null, 2));

  res.status(200).json({ received: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`PayX server running on port ${PORT}`);
});
