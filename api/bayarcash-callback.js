import { db } from "./_firebaseAdmin.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getPaymentStatus(payload) {
  const raw = String(
    payload.status ||
    payload.payment_status ||
    payload.transaction_status ||
    payload.state ||
    ""
  ).toLowerCase();

  if (["paid", "success", "successful", "completed", "complete"].includes(raw)) {
    return "paid";
  }

  if (["failed", "fail", "cancelled", "canceled", "cancel", "expired"].includes(raw)) {
    return "failed";
  }

  return "pending_payment";
}

function getGatewayReference(payload) {
  return (
    payload.transaction_id ||
    payload.transactionId ||
    payload.reference_id ||
    payload.referenceId ||
    payload.id ||
    null
  );
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

async function deductInventory(orderId, order) {
  if (order.inventoryDeducted === true) return;

  for (const item of order.items || []) {
    const productId = item.productId;
    const qty = Number(item.qty || 0);

    if (!productId || qty <= 0) continue;

    const productRef = db().collection("Products").doc(productId);
    const productDoc = await productRef.get();

    if (!productDoc.exists) continue;

    const product = productDoc.data();
    const currentStock = Number(product.stock || 0);
    const newStock = Math.max(currentStock - qty, 0);

    await productRef.update({
      stock: newStock,
      status: newStock <= 0 ? "out_of_stock" : "active",
      updatedAt: new Date().toISOString()
    });
  }

  await db().collection("Orders").doc(orderId).update({
    inventoryDeducted: true,
    inventoryDeductedAt: new Date().toISOString()
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const orderId = req.query.orderId;
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!orderId) {
      return json(res, 400, { error: "Missing orderId" });
    }

    const orderRef = db().collection("Orders").doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return json(res, 404, { error: "Order not found" });
    }

    const oldOrder = orderDoc.data();
    const paymentStatus = getPaymentStatus(payload);
    const gatewayRef = getGatewayReference(payload);

    const updateData = {
      paymentStatus,
      paymentReference: gatewayRef || "",
      gatewayCallback: payload,
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
      id: orderId
    };

    if (paymentStatus === "paid") {
      await deductInventory(orderId, updatedOrder);
      await sendPaidOrderEmails(updatedOrder);

      await orderRef.update({
        paymentEmailSent: true,
        paymentEmailSentAt: new Date().toISOString()
      });
    }

    return json(res, 200, {
      ok: true,
      orderId,
      paymentStatus
    });

  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
}