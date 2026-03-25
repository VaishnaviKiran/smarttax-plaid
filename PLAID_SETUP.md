# SmartTax AI — Plaid Production Setup

## 1. Install dependencies

```bash
# Frontend
npm install react-plaid-link

# Backend
npm install express plaid dotenv cors jsonwebtoken pg jose
```

---

## 2. Environment variables

```env
# .env (backend)
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_production_secret
PLAID_ENV=production
PLAID_WEBHOOK_URL=https://api.yourapp.com/api/plaid/webhook
JWT_SECRET=your_app_jwt_secret
DATABASE_URL=postgres://user:pass@host:5432/smarttax
FRONTEND_URL=https://yourapp.com
PORT=3001
```

---

## 3. Database schema

Run once in Postgres:

```sql
CREATE TABLE plaid_items (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  item_id       TEXT NOT NULL UNIQUE,
  cursor        TEXT,                  -- transactions/sync cursor position
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON plaid_items (user_id);

-- Optional: store processed transactions for fast querying
CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY,  -- Plaid transaction_id
  user_id             TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  amount              NUMERIC NOT NULL,
  date                DATE NOT NULL,
  name                TEXT,
  merchant_name       TEXT,
  category_primary    TEXT,
  category_detailed   TEXT,
  pending             BOOLEAN DEFAULT false,
  -- SmartTax fields
  deduction_category  TEXT,
  confidence_score    NUMERIC,
  deduction_amount    NUMERIC,
  user_confirmed      BOOLEAN,          -- null=pending, true=confirmed, false=rejected
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON transactions (user_id, date DESC);
CREATE INDEX ON transactions (user_id, user_confirmed);
```

---

## 4. Use the React component

```jsx
import PlaidConnect from "./PlaidConnect";

function OnboardingScreen({ userId, authToken }) {
  return (
    <PlaidConnect
      userId={userId}
      authToken={authToken}       // your app's JWT — never a Plaid key
      onSuccess={({ accounts }) => {
        // Update Tax Health Score +15, navigate to dashboard
      }}
      onExit={({ err }) => {
        if (err) console.warn("Plaid exited:", err);
      }}
    />
  );
}
```

---

## 5. Auth flow (how it all connects)

```
User is logged into SmartTax → has app JWT
        │
        ▼
React mounts PlaidConnect
→ POST /api/plaid/create-link-token   (JWT in Authorization header)
  Backend verifies JWT → reads userId from token
  Calls Plaid API → returns link_token (expires in 30 min)
        │
        ▼
Plaid Link modal opens
User selects bank + authenticates with their bank
Plaid returns public_token (one-time, 30 min TTL)
        │
        ▼
React → POST /api/plaid/exchange-token  { publicToken }
  Backend verifies JWT → gets userId
  Calls Plaid → exchanges for permanent access_token
  Stores access_token + item_id in Postgres (never sent to client)
  Returns: { accounts: [...] }
        │
        ▼
Background: syncTransactions() pulls 90 days via /transactions/sync
Future:     Plaid webhook fires → syncTransactions() → classify → score
```

---

## 6. Webhook setup

Plaid fires your webhook on new transactions. For local development:

```bash
# Install ngrok, then:
ngrok http 3001
# Copy the https URL → set as PLAID_WEBHOOK_URL in .env
# Update the webhook URL in your Plaid dashboard
```

For production, your webhook URL must be publicly accessible over HTTPS.

**Plaid webhook verification** is implemented in `plaid-server.js`. For full production
verification using JWKS, install `jose` and uncomment the verification block. See:
https://plaid.com/docs/api/webhooks/webhook-verification/

---

## 7. Production security checklist

- [ ] **Encrypt `access_token` at rest** in Postgres (use pgcrypto or your KMS)
- [ ] **Never log or return `access_token`** to the client or in server logs
- [ ] **JWT auth on every route** — middleware already applied, don't remove it
- [ ] **Verify Plaid webhook signatures** — skeleton in place, enable full JWKS verification
- [ ] **Rate-limit** `/api/plaid/*` endpoints (use `express-rate-limit`)
- [ ] **HTTPS only** — never serve Plaid routes over HTTP in production
- [ ] **Rotate Plaid secret** if ever exposed — do it in the Plaid dashboard immediately
- [ ] **Handle `ITEM_LOGIN_REQUIRED`** webhook — prompt user to re-authenticate
- [ ] **Add Plaid products to your Plaid dashboard** (Transactions must be enabled)
- [ ] **Apply for Plaid production access** at dashboard.plaid.com before go-live

---

## 8. Plaid environment progression

| Stage        | PLAID_ENV     | Credentials         | Real banks? |
|--------------|---------------|---------------------|-------------|
| Development  | `sandbox`     | Sandbox secret      | No (test)   |
| Staging      | `development` | Development secret  | Yes (250 items limit) |
| Production   | `production`  | Production secret   | Yes         |

Apply for production access in the Plaid dashboard. It takes 1–5 business days.

---

## 9. Next steps — wire into SmartTax features

| Spec feature               | Where to plug in                                      |
|----------------------------|-------------------------------------------------------|
| Feature 02 — Deduction tracking | `syncTransactions()` → pass `added` to your AI classifier |
| Feature 03 — Tax Health Score   | After sync, recalculate score for `userId`            |
| Feature 07 — Dashboard accounts | `GET /api/plaid/accounts` → account cards             |
| Feature 07 — Transaction cards  | Webhook → `syncTransactions()` → push notification    |
| Streak engine              | Log categorization action after user confirms deduction |
| CSV export                 | Query `transactions` table, filter by `user_confirmed` |
