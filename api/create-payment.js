import crypto from "crypto";
import fetch from "node-fetch";
import { db } from "./_firebaseAdmin.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function makeOrderNumber() {
  return "VEL-" + Date.now().toString(36).toUpperCase();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function generatePaymentIntentChecksum(payload, secretKey) {
  const sortedKeys = Object.keys(payload).sort();

  const payloadString = sortedKeys
    .map((key) => String(payload[key] ?? "").trim())
    .join("|");

  return crypto
    .createHmac("sha256", String(secretKey || "").trim())
    .update(payloadString)
    .digest("hex");
}

function findPaymentUrl(result) {
  return (
    result?.url ||
    result?.payment_url ||
    result?.paymentUrl ||
    result?.redirect_url ||
    result?.redirectUrl ||
    result?.data?.url ||
    result?.data?.payment_url ||
    result?.data?.redirect_url ||
    result?.payment_intent?.url ||
    result?.payment_intent?.payment_url ||
    null
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { customer, items, total } = body || {};

    if (!customer?.name || !customer?.email || !customer?.phone) {
      return json(res, 400, { error: "Missing customer details" });
    }

    if (!Array.isArray(items) || items.length === 0 || !Number(total)) {
      return json(res, 400, { error: "Missing order items or total" });
    }

    const requiredEnv = [
      "BAYARCASH_PAT",
      "BAYARCASH_SECRET_KEY",
      "BAYARCASH_PORTAL_KEY",
      "SITE_URL",
      "FIREBASE_SERVICE_ACCOUNT"
    ];

    const missingEnv = requiredEnv.filter((name) => !process.env[name]);

    if (missingEnv.length) {
      return json(res, 500, {
        error: `Missing env variables: ${missingEnv.join(", ")}`
      });
    }

    const orderNumber = makeOrderNumber();
    const amount = Number(total);

    const orderRef = await db().collection("Orders").add({
      orderNumber,
      customerName: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address || "",
      postcode: customer.postcode || "",
      city: customer.city || "",
      state: customer.state || "",
      items,
      totalAmount: Number(total),
      currency: "MYR",
      paymentStatus: "unpaid",
      paymentMethod: "bayarcash",
      paymentReference: "",
      status: "pending",
      source: "website",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const returnUrl =
`${process.env.SITE_URL}/payment-status.html?order=${encodeURIComponent(orderNumber)}&id=${orderRef.id}`;

    const metadata = JSON.stringify({
      orderId: orderRef.id,
      orderNumber
    });

    const paymentPayload = {
      payment_channel: Number(process.env.BAYARCASH_PAYMENT_CHANNEL || 5),
      portal_key: process.env.BAYARCASH_PORTAL_KEY,
      order_number: orderNumber,
      amount,
      payer_name: customer.name,
      payer_email: customer.email,
      payer_telephone_number: normalizePhone(customer.phone),
      payer_bank_code: customer.bankCode || "",
      payer_bank_name: customer.bankName || "",
      metadata,
      return_url: returnUrl,
      callback_url: `${process.env.SITE_URL}/api/bayarcash-callback?orderId=${orderRef.id}`,
      platform_id: process.env.BAYARCASH_PLATFORM_ID || "veloura"
    };

    const checksumPayload = {
  payment_channel: paymentPayload.payment_channel,
  order_number: paymentPayload.order_number,
  amount: paymentPayload.amount,
  payer_name: paymentPayload.payer_name,
  payer_email: paymentPayload.payer_email
};

paymentPayload.checksum = generatePaymentIntentChecksum(
  checksumPayload,
  process.env.BAYARCASH_SECRET_KEY
);

    const response = await fetch(
      "https://api.console.bayar.cash/v3/payment-intents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.BAYARCASH_PAT}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(paymentPayload)
      }
    );

    const result = await response.json().catch(() => ({}));

    await orderRef.update({
      bayarcashPayload: {
        ...paymentPayload,
        checksum: "[hidden]"
      },
      bayarcashResponse: result,
      updatedAt: new Date().toISOString()
    });

    if (!response.ok) {
      return json(res, response.status, {
        error: "Bayarcash payment creation failed",
        details: result
      });
    }

    const paymentUrl = findPaymentUrl(result);

    if (!paymentUrl) {
      return json(res, 500, {
        error: "Bayarcash payment URL not found in response",
        details: result
      });
    }

    return json(res, 200, {
      orderId: orderRef.id,
      orderNumber,
      paymentUrl,
      mode: "live"
    });

  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message });
  }
}