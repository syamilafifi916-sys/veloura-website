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

function makeRequestId() {
  return crypto.randomUUID();
}

function normalizePhoneMY(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "+60000000000";
  if (digits.startsWith("60")) return `+${digits}`;
  if (digits.startsWith("0")) return `+6${digits}`;
  return `+60${digits}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

function generateDigest(jsonBody) {
  return crypto.createHash("sha256").update(jsonBody, "utf8").digest("base64");
}

function generateSignature({ clientId, requestId, timestamp, requestTarget, digest, secretKey }) {
  let component = `Client-Id:${clientId}`;
  component += `\nRequest-Id:${requestId}`;
  component += `\nRequest-Timestamp:${timestamp}`;
  component += `\nRequest-Target:${requestTarget}`;

  if (digest) {
    component += `\nDigest:${digest}`;
  }

  const signature = crypto
    .createHmac("sha256", String(secretKey || "").trim())
    .update(component)
    .digest("base64");

  return `HMACSHA256=${signature}`;
}

function findCheckoutUrl(result) {
  return (
    result?.payment?.checkout_url ||
    result?.checkout_experience?.checkout_url ||
    result?.checkout_url ||
    result?.paymentUrl ||
    result?.redirect_url ||
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
      "DOKU_CLIENT_ID",
      "DOKU_SECRET_KEY",
      "DOKU_API_KEY",
      "SITE_URL",
      "FIREBASE_SERVICE_ACCOUNT"
    ];

    const missingEnv = requiredEnv.filter((name) => !process.env[name]);

    if (missingEnv.length) {
      return json(res, 500, {
        error: `Missing env variables: ${missingEnv.join(", ")}`
      });
    }
    console.log("DOKU DEBUG", {
  clientId: process.env.DOKU_CLIENT_ID,
  apiKeyPrefix: process.env.DOKU_API_KEY?.slice(0, 9),
  apiKeyLength: process.env.DOKU_API_KEY?.length,
  secretKeyPrefix: process.env.DOKU_SECRET_KEY?.slice(0, 5),
  secretKeyLength: process.env.DOKU_SECRET_KEY?.length,
  apiBaseUrl: process.env.DOKU_API_BASE_URL,
  apiVersion: process.env.DOKU_API_VERSION
});

    const orderNumber = makeOrderNumber();
    const amount = Number(total);
    const siteUrl = String(process.env.SITE_URL || "").replace(/\/$/, "");
    const apiBaseUrl = process.env.DOKU_API_BASE_URL || "https://api.doku.com";
    const requestTarget = "/v3/checkouts";
    const requestId = makeRequestId();
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiredAt = addMinutes(new Date(), Number(process.env.DOKU_PAYMENT_DUE_DATE || 60));

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
      totalAmount: amount,
      currency: "MYR",
      paymentStatus: "unpaid",
      paymentMethod: "doku",
      paymentReference: "",
      status: "pending",
      source: "website",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const paymentPayload = {
      id: orderRef.id,
      order: {
        amount,
        invoice_number: orderNumber,
        currency: process.env.DOKU_CURRENCY || "MYR",
        line_items: [
  ...items.map((item, index) => ({
    id: String(item.productId || item.id || index + 1),
    name: String(item.name || "Veloura Item").slice(0, 100),
    quantity: Number(item.qty || 1),
    price: Number(item.price || item.unitPrice || item.salePrice || ((Number(item.subtotal || 0) / Number(item.qty || 1)) || 0))
  })),
  ...(amount > items.reduce((sum, item) => sum + (Number(item.price || item.subtotal || 0) * Number(item.qty || 1)), 0)
    ? [{
        id: "shipping",
        name: "Shipping Fee",
        quantity: 1,
        price: amount - items.reduce((sum, item) => sum + (Number(item.price || item.subtotal || 0) * Number(item.qty || 1)), 0)
      }]
    : [])
],
        expired_at: expiredAt
      },
      checkout_experience: {
        language: "EN",
        auto_redirect: true,
        retry_payment: {
          enabled: true
        },
        callback_url: `${siteUrl}/payment-status.html?order=${encodeURIComponent(orderNumber)}&id=${orderRef.id}`,
        callback_url_cancel: `${siteUrl}/checkout.html`,
        callback_url_result: `${siteUrl}/payment-status.html?order=${encodeURIComponent(orderNumber)}&id=${orderRef.id}`
      },
      payment: {
        type: "SALE"
      },
      metadata: {
        orderId: orderRef.id,
        orderNumber
      },
      customer: {
        id: orderRef.id,
        name: customer.name,
        email: customer.email,
        phone: normalizePhoneMY(customer.phone),
        country: "MY",
        address: customer.address || ""
      },
      shipping_address: {
        first_name: customer.name.split(" ")[0] || customer.name,
        last_name: customer.name.split(" ").slice(1).join(" ") || "-",
        address: customer.address || "",
        city: customer.city || "",
        postal_code: customer.postcode || "",
        phone: normalizePhoneMY(customer.phone),
        country_code: "MY"
      }
    };

    const jsonBody = JSON.stringify(paymentPayload);
    const digest = generateDigest(jsonBody);

    const signature = generateSignature({
      clientId: process.env.DOKU_CLIENT_ID,
      requestId,
      timestamp,
      requestTarget,
      digest,
      secretKey: process.env.DOKU_SECRET_KEY
    });

const dokuRequestHeaders = {
  Authorization: `Basic ${Buffer.from(`${process.env.DOKU_API_KEY}`).toString("base64")}`,
  "Client-Id": process.env.DOKU_CLIENT_ID,
  "Request-Id": requestId,
  "Request-Timestamp": timestamp,
  "Request-Target": requestTarget,
  "API-Version": process.env.DOKU_API_VERSION || "arabica.2025-12-01",
  Signature: signature,
  Digest: digest,
  "Content-Type": "application/json",
  Accept: "application/json"
};

console.log("===== DOKU REQUEST HEADER =====");
console.log({
  ...dokuRequestHeaders,
  Authorization: "Basic ********",
  Signature: signature.substring(0, 25) + "..."
});

console.log("===== DOKU REQUEST BODY =====");
console.log(JSON.stringify(paymentPayload, null, 2));
    const response = await fetch(`${apiBaseUrl}${requestTarget}`, {
      method: "POST",
      headers: dokuRequestHeaders,
      body: jsonBody
    });

    const result = await response.json().catch(() => ({}));
console.log("===== DOKU RESPONSE STATUS =====");
console.log(response.status);

console.log("===== DOKU RESPONSE BODY =====");
console.log(JSON.stringify(result, null, 2));
    await orderRef.update({
      dokuPayload: paymentPayload,
      dokuResponse: result,
      dokuRequestId: requestId,
      updatedAt: new Date().toISOString()
    });

    if (!response.ok) {
      return json(res, response.status, {
        error: "DOKU payment creation failed",
        details: result
      });
    }

    const paymentUrl = findCheckoutUrl(result);

    if (!paymentUrl) {
      return json(res, 500, {
        error: "DOKU checkout URL not found in response",
        details: result
      });
    }

    return json(res, 200, {
      orderId: orderRef.id,
      orderNumber,
      paymentUrl,
      mode: "doku"
    });

  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message });
  }
}