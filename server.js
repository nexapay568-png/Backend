const express = require('express');
const cors = require('cors');
const { PayX } = require('payx-node');

const app = express();
const PORT = process.env.PORT || 3000;

const LIVE_API_KEY = 'px_live_03752dd30078482b815d878e551c67bc';
const LIVE_WEBHOOK_SECRET = 'whsec_live_e7bcdfbd5de24883a17a00f4318cc90f';

const payx = new PayX({ apiKey: LIVE_API_KEY });

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

  try {
    const response = await payx.charge.create({
      amount: parseFloat(amount),
      currency: 'GHS',
      phoneNumber: phoneNumber,
      network: network.toUpperCase(),
      payerMessage: `Payment from ${name || phoneNumber}`,
      payeeNote: `Deposit - ${name || phoneNumber}`,
    });

    const receipt = generateReceipt(
      response.transactionId,
      amount,
      phoneNumber,
      name,
      network,
      response.status || 'PENDING',
      null
    );

    return res.status(202).json({
      success: true,
      message: response.message || 'Transaction initiated. Check your phone for the USSD prompt.',
      transactionId: response.transactionId,
      status: response.status || 'PENDING',
      ...receipt,
    });
  } catch (err) {
    const errorMessage =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      'An unexpected error occurred.';

    const errorDetails =
      err?.response?.data || null;

    const receipt = generateReceipt(
      null,
      amount,
      phoneNumber,
      name,
      network,
      'FAILED',
      errorMessage
    );

    return res.status(err?.response?.status || 500).json({
      success: false,
      error: errorMessage,
      details: errorDetails,
      ...receipt,
    });
  }
});

app.post('/webhooks', (req, res) => {
  const signature = req.headers['x-payx-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing signature header.' });
  }

  let isValid = false;
  try {
    isValid = payx.webhooks.verifySignature(
      JSON.stringify(req.body),
      signature,
      LIVE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(401).json({ error: 'Signature verification error: ' + err.message });
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  const event = req.body;
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
