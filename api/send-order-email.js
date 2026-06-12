export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      orderNumber,
      customerName,
      email,
      phone,
      address,
      paymentStatus = "unpaid",
      status = "pending",
      totalAmount,
      items = []
    } = req.body;

    if (!orderNumber || !email) {
      return res.status(400).json({ error: "Missing order details" });
    }

    const itemList = items
      .map(item => `<li>${item.name} × ${item.qty || 1} — RM ${item.subtotal || item.price || 0}</li>`)
      .join("");

    const customerHtml = `
      <h2>Thank you for your order, ${customerName || "Customer"}.</h2>
      <p>Your Veloura order has been received.</p>
      <p><strong>Order Number:</strong> ${orderNumber}</p>
      <p><strong>Total:</strong> RM ${totalAmount}</p>
      <p><strong>Payment Status:</strong> ${String(paymentStatus).toUpperCase()}</p>
      <h3>Items</h3>
      <ul>${itemList}</ul>
      <p>You can track your order once it has been processed.</p>
    `;

    const adminHtml = `
      <h2>New Veloura Order Received</h2>

      <p><strong>Order Number:</strong> ${orderNumber}</p>
      <p><strong>Customer:</strong> ${customerName || "-"}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone || "-"}</p>

      <p><strong>Shipping Address:</strong><br>
      ${address || "-"}
      </p>

      <p><strong>Payment Status:</strong> ${String(paymentStatus || "unpaid").toUpperCase()}</p>
      <p><strong>Order Status:</strong> ${status || "pending"}</p>

      <p style="color:#C44536;">
        <strong>Fulfilment Note:</strong>
        Do not ship until payment status is PAID.
      </p>

      <p><strong>Total:</strong> RM ${totalAmount}</p>

      <h3>Items</h3>
      <ul>${itemList}</ul>
    `;

    const sendEmail = async ({ to, subject, html }) => {
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

      const result = await response.json();

      if (!response.ok) {
        throw new Error(JSON.stringify(result));
      }

      return result;
    };

    const customerEmail = await sendEmail({
      to: email,
      subject: `Veloura Order Confirmation - ${orderNumber}`,
      html: customerHtml
    });

    const adminEmail = await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `New Veloura Order - ${orderNumber} [${String(paymentStatus).toUpperCase()}]`,
      html: adminHtml
    });

    return res.status(200).json({
      success: true,
      customerEmail,
      adminEmail
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}