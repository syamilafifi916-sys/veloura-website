import crypto from "crypto";
import { db } from "./_firebaseAdmin.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
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

function getHeader(req, name) {
  const key = Object.keys(req.headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? req.headers[key] : "";
}

function safeCompare(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function getPaymentStatus(payload) {
  const raw = String(
    payload?.payment?.status ||
    payload?.payment?.state ||
    payload?.status ||
    payload?.state ||
    payload?.transaction_status ||
    payload?.payment_status ||
    ""
  ).toUpperCase();

  if (["SUCCESS", "COMPLETED", "COMPLETE", "PAID", "SETTLED"].includes(raw)) {
    return "paid";
  }

  if (["FAILED", "EXPIRED", "CANCELLED", "CANCELED", "VOID"].includes(raw)) {
    return "failed";
  }

  return "pending_payment";
}

function getGatewayReference(payload) {
  return (
    payload?.payment?.id ||
    payload?.payment?.reference_id ||
    payload?.transaction_id ||
    payload?.reference_id ||
    payload?.id ||
    payload?.order?.invoice_number ||
    null
  );
}

function getOrderNumber(payload) {
  return (
    payload?.metadata?.orderNumber ||
    payload?.metadata?.order_number ||
    payload?.order?.invoice_number ||
    payload?.invoice_number ||
    null
  );
}

function getOrderId(payload) {
  return (
    payload?.metadata?.orderId ||
    payload?.metadata?.order_id ||
    payload?.id ||
    null
  );
}

async function findOrderRef(payload, queryOrderId) {
  const orderId = queryOrderId || getOrderId(payload);

  if (orderId) {
    const directRef = db().collection("Orders").doc(orderId);
    const directDoc = await directRef.get();
    if (directDoc.exists) return directRef;
  }

  const orderNumber = getOrderNumber(payload);

  if (orderNumber) {
    const snap = await db()
      .collection("Orders")
      .where("orderNumber", "==", orderNumber)
      .limit(1)
      .get();

    if (!snap.empty) return snap.docs[0].ref;
  }

  return null;
}

function itemListHtml(items = []) {
  return items.map(item => `
    <li>
      ${item.name || "Item"} 
      ${item.size ? `(${item.size}` : ""}
      ${item.color ? ` ${item.color}` : ""}
      ${item.size ? `)` : ""}
      × ${item.qty || 1}
      — RM ${item.subtotal || item.price || 0}
    </li>
  `).join("");
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY || !to) return null;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(process.env.RESEND_API_KEY || "").trim()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || "onboarding@resend.dev",
      to,
      subject,
      html
    })
  });

  return response.json().catch(() => ({}));
}

async function sendPaidOrderEmails(order) {
  if (order.paymentEmailSent === true) return;

  const orderNo = order.orderNumber || order.orderNo || "-";
  const itemsHtml = itemListHtml(order.items || []);
  const total = Number(order.totalAmount || order.total || 0).toFixed(2);

  const customerHtml = `
    <h2>Payment Received</h2>
    <p>Hi ${order.customerName || "Customer"},</p>
    <p>Thank you. Your Veloura payment has been received successfully.</p>
    <p><strong>Order Number:</strong> ${orderNo}</p>
    <p><strong>Total:</strong> RM ${total}</p>
    <h3>Items</h3>
    <ul>${itemsHtml}</ul>
    <p>We will process your order and update you once it is ready for shipping.</p>
  `;

  const adminHtml = `
    <h2>Paid Order Received</h2>
    <p><strong>Order Number:</strong> ${orderNo}</p>
    <p><strong>Customer:</strong> ${order.customerName || "-"}</p>
    <p><strong>Email:</strong> ${order.email || "-"}</p>
    <p><strong>Phone:</strong> ${order.phone || "-"}</p>
    <p><strong>Address:</strong><br>
      ${order.address || "-"}<br>
      ${order.postcode || ""} ${order.city || ""}<br>
      ${order.state || ""}
    </p>
    <p><strong>Payment Status:</strong> PAID</p>
    <p><strong>Total:</strong> RM ${total}</p>
    <h3>Items</h3>
    <ul>${itemsHtml}</ul>
    <p style="color:#2e7d32;"><strong>Fulfilment:</strong> Payment confirmed. You may process this order.</p>
  `;

  await Promise.allSettled([
    sendEmail({
      to: order.email,
      subject: `Veloura Payment Received - ${orderNo}`,
      html: customerHtml
    }),
    sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `Paid Veloura Order - ${orderNo}`,
      html: adminHtml
    })
  ]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(payload || {});

    if (process.env.DOKU_VERIFY_WEBHOOK !== "false") {
      const clientId = getHeader(req, "Client-Id");
      const requestId = getHeader(req, "Request-Id");
      const timestamp = getHeader(req, "Request-Timestamp");
      const incomingSignature = getHeader(req, "Signature");
      const requestTarget = "/api/doku-callback";
      const digest = generateDigest(rawBody);

      const expectedSignature = generateSignature({
        clientId,
        requestId,
        timestamp,
        requestTarget,
        digest,
        secretKey: process.env.DOKU_SECRET_KEY
      });

      if (!incomingSignature || !safeCompare(incomingSignature, expectedSignature)) {
        return json(res, 401, { error: "Invalid DOKU signature" });
      }
    }

    const orderRef = await findOrderRef(payload, req.query.orderId);

    if (!orderRef) {
      return json(res, 404, { error: "Order not found" });
    }

    const orderDoc = await orderRef.get();
    const oldOrder = orderDoc.data();

    const paymentStatus = getPaymentStatus(payload);
    const gatewayRef = getGatewayReference(payload);

    const updateData = {
      paymentStatus,
      paymentMethod: "doku",
      paymentReference: gatewayRef || "",
      dokuCallback: payload,
      updatedAt: new Date().toISOString()
    };

    if (paymentStatus === "paid") {
      updateData.status = "paid";
      updateData.paidAt = new Date().toISOString();
    }

    if (paymentStatus === "failed") {
      updateData.status = "payment_failed";
      updateData.failedAt = new Date().toISOString();
    }

    await orderRef.update(updateData);

    const updatedOrder = {
      ...oldOrder,
      ...updateData,
      id: orderRef.id
    };

    if (paymentStatus === "paid" && oldOrder.paymentEmailSent !== true) {
      await sendPaidOrderEmails(updatedOrder);

      await orderRef.update({
        paymentEmailSent: true,
        paymentEmailSentAt: new Date().toISOString()
      });
    }

    return json(res, 200, {
      ok: true,
      orderId: orderRef.id,
      paymentStatus
    });

  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
}