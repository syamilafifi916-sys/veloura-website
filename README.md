# Veloura Backend Starter

Backend starter untuk admin order + Bayarcash-ready payment flow.

## Struktur
- `public/admin/index.html` — admin dashboard Firebase Auth + Firestore
- `api/create-payment.js` — create order + placeholder Bayarcash payment request
- `api/bayarcash-callback.js` — webhook/callback endpoint
- `firestore.rules` — basic Firestore security rules
- `public/js/firebase-config.example.js` — rename to `firebase-config.js`

## Setup ringkas
1. Create Firebase project.
2. Enable Authentication > Email/Password.
3. Create Firestore database.
4. Add admin user in Firebase Auth.
5. Add document `admins/{ADMIN_UID}` in Firestore.
6. Copy Firebase web config into `public/js/firebase-config.js`.
7. Create service account JSON and put as Vercel env `FIREBASE_SERVICE_ACCOUNT`.
8. Add Bayarcash env vars: `BAYARCASH_PAT`, `BAYARCASH_SECRET_KEY`, `BAYARCASH_PORTAL_KEY`, `SITE_URL`.
9. Deploy to Vercel.

## Frontend checkout integration
Your existing Veloura checkout should POST this payload to `/api/create-payment`:

```js
const payload = {
  customer: { name, email, phone, address },
  items: cart,
  total: cart.reduce((s, i) => s + i.sale * i.qty, 0)
};

const res = await fetch('/api/create-payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
const data = await res.json();
window.location.href = data.paymentUrl;
```

## Nota penting Bayarcash
Endpoint dan exact payload perlu disahkan dengan merchant console / API v3 docs. PAT dan API Secret Key mesti disimpan di server-side sahaja.
