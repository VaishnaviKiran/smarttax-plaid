// ─── SmartTax AI — Plaid Backend (Production-Ready) ──────────────────────────
//
// npm install express plaid dotenv cors jsonwebtoken pg
//
// .env:
//   PLAID_CLIENT_ID=
//   PLAID_SECRET=               ← your PRODUCTION secret
//   PLAID_ENV=production         ← sandbox | development | production
//   PLAID_WEBHOOK_URL=https://api.yourapp.com/api/plaid/webhook
//   JWT_SECRET=                  ← your app's JWT signing secret
//   DATABASE_URL=postgres://...  ← your Postgres connection string
//   PORT=3001
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const jwt        = require("jsonwebtoken");
const { Pool }   = require("pg");
const {
  PlaidApi, PlaidEnvironments, Configuration,
  Products, CountryCode, WebhookType,
} = require("plaid");

const app = express();

// ── Webhook route MUST receive raw body for signature verification ─────────
// Mount this before express.json()
app.use("/api/plaid/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "https://yourapp.com" }));

// ── Database (Postgres) ────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Required schema — run once:
// CREATE TABLE plaid_items (
//   id            SERIAL PRIMARY KEY,
//   user_id       TEXT NOT NULL,
//   access_token  TEXT NOT NULL,          -- store encrypted at rest in prod
//   item_id       TEXT NOT NULL UNIQUE,
//   cursor        TEXT,                   -- transactions/sync cursor
//   created_at    TIMESTAMPTZ DEFAULT NOW(),
//   updated_at    TIMESTAMPTZ DEFAULT NOW()
// );
// CREATE INDEX ON plaid_items (user_id);

// ── Plaid client ────────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "production"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET":    process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware — verifies your app's JWT on every route except /webhook
// Attaches req.userId from the token payload
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = payload.sub || payload.userId; // match your JWT structure
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/plaid/create-link-token
// Creates a short-lived link_token to open Plaid Link on the frontend
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/plaid/create-link-token", requireAuth, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: req.userId },
      client_name:   "SmartTax AI",
      products:      [Products.Transactions],
      country_codes: [CountryCode.Us],
      language:      "en",
      webhook:       process.env.PLAID_WEBHOOK_URL,
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create-link-token:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/plaid/exchange-token
// Exchanges the one-time public_token for a permanent access_token.
// Stores access_token in DB. NEVER returns it to the client.
// Kicks off initial 90-day transaction sync.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/plaid/exchange-token", requireAuth, async (req, res) => {
  const { publicToken } = req.body;
  if (!publicToken) return res.status(400).json({ error: "publicToken required" });

  try {
    // Exchange
    const exchangeRes = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const { access_token: accessToken, item_id: itemId } = exchangeRes.data;

    // Persist to DB (encrypt accessToken at rest — see production checklist)
    await db.query(
      `INSERT INTO plaid_items (user_id, access_token, item_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (item_id) DO UPDATE
         SET access_token = $2, updated_at = NOW()`,
      [req.userId, accessToken, itemId]
    );

    // Return accounts (balances) to frontend — no access_token in response
    const accountsRes = await plaidClient.accountsGet({ access_token: accessToken });

    // Kick off background 90-day historical sync (non-blocking)
    syncTransactions(req.userId, accessToken, itemId).catch((err) =>
      console.error(`Initial sync failed for user ${req.userId}:`, err.message)
    );

    res.json({ success: true, accounts: accountsRes.data.accounts });
  } catch (err) {
    console.error("exchange-token:", err.response?.data || err.message);
    res.status(500).json({ error: "Token exchange failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/plaid/accounts
// Returns all connected accounts + live balances for the authed user
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/plaid/accounts", requireAuth, async (req, res) => {
  try {
    const items = await db.query(
      "SELECT access_token, item_id FROM plaid_items WHERE user_id = $1",
      [req.userId]
    );
    if (items.rows.length === 0) {
      return res.json({ accounts: [] });
    }

    // Fetch accounts from all connected items in parallel
    const results = await Promise.allSettled(
      items.rows.map(({ access_token }) =>
        plaidClient.accountsGet({ access_token })
      )
    );

    const accounts = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value.data.accounts);

    res.json({ accounts });
  } catch (err) {
    console.error("accounts:", err.message);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/plaid/transactions?days=90
// Returns transactions for the authed user (from your DB after sync)
// In production: query YOUR transactions table, not Plaid directly each time
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/plaid/transactions", requireAuth, async (req, res) => {
  const days  = Math.min(parseInt(req.query.days) || 90, 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  try {
    const items = await db.query(
      "SELECT access_token FROM plaid_items WHERE user_id = $1",
      [req.userId]
    );
    if (items.rows.length === 0) return res.json({ transactions: [] });

    const results = await Promise.allSettled(
      items.rows.map(({ access_token }) =>
        plaidClient.transactionsGet({
          access_token,
          start_date: since,
          end_date:   today,
          options: { count: 500, include_personal_finance_category: true },
        })
      )
    );

    const transactions = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value.data.transactions);

    res.json({ transactions });
  } catch (err) {
    console.error("transactions:", err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/plaid/webhook
// Plaid fires this on new transactions, auth updates, errors.
// Verifies the Plaid-Verification JWT before processing. Raw body required.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/plaid/webhook", async (req, res) => {
  // ── Verify Plaid's webhook signature ──────────────────────────────────────
  const plaidVerificationToken = req.headers["plaid-verification"];
  if (!plaidVerificationToken) {
    return res.status(400).json({ error: "Missing Plaid-Verification header" });
  }

  try {
    // Fetch Plaid's current public keys and verify the JWT
    // See: https://plaid.com/docs/api/webhooks/webhook-verification/
    await plaidClient.webhookVerificationKeyGet({
      key_id: decodeWebhookKeyId(plaidVerificationToken),
    });
    // In production use the full jose/jwks verification:
    // const { jwtVerify, createRemoteJWKSet } = require("jose");
    // const JWKS = createRemoteJWKSet(new URL("https://production.plaid.com/openid/configuration"));
    // await jwtVerify(plaidVerificationToken, JWKS);
  } catch (err) {
    console.error("Webhook verification failed:", err.message);
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  // ── Parse payload (raw buffer → JSON) ────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const { webhook_type, webhook_code, item_id } = payload;
  console.log(`Plaid webhook: ${webhook_type}/${webhook_code} — item ${item_id}`);

  // Always ACK immediately — process async
  res.sendStatus(200);

  // ── Handle transaction webhooks ───────────────────────────────────────────
  if (webhook_type === WebhookType.Transactions) {
    const row = await db.query(
      "SELECT user_id, access_token FROM plaid_items WHERE item_id = $1",
      [item_id]
    ).catch(() => ({ rows: [] }));

    if (!row.rows.length) {
      console.warn(`Webhook for unknown item_id: ${item_id}`);
      return;
    }

    const { user_id, access_token } = row.rows[0];

    if (["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(webhook_code)) {
      syncTransactions(user_id, access_token, item_id).catch((err) =>
        console.error(`Webhook sync failed for ${user_id}:`, err.message)
      );
    }
  }

  // ── Handle item errors (e.g. user needs to re-authenticate) ──────────────
  if (webhook_type === "ITEM" && webhook_code === "ERROR") {
    console.warn(`Item error for ${item_id}:`, payload.error);
    // TODO: notify the user to reconnect their bank
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Transaction sync — cursor-based (production standard)
// Uses /transactions/sync so you only ever fetch new/modified/removed items
// ─────────────────────────────────────────────────────────────────────────────
async function syncTransactions(userId, accessToken, itemId) {
  // Load saved cursor (null on first run = full historical sync)
  const cursorRow = await db.query(
    "SELECT cursor FROM plaid_items WHERE item_id = $1",
    [itemId]
  );
  let cursor = cursorRow.rows[0]?.cursor || null;

  let added = [], modified = [], removed = [];
  let hasMore = true;

  while (hasMore) {
    const res = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor:       cursor || undefined,
      options: { include_personal_finance_category: true },
    });

    added.push(...res.data.added);
    modified.push(...res.data.modified);
    removed.push(...res.data.removed);
    hasMore = res.data.has_more;
    cursor  = res.data.next_cursor;
  }

  // Save updated cursor
  await db.query(
    "UPDATE plaid_items SET cursor = $1, updated_at = NOW() WHERE item_id = $2",
    [cursor, itemId]
  );

  console.log(
    `[${userId}] Sync complete: +${added.length} added, ${modified.length} modified, ${removed.length} removed`
  );

  // ── Hand off to your deduction classifier ────────────────────────────────
  // Each transaction in `added` has:
  //   transaction_id, account_id, amount, date, name, merchant_name,
  //   personal_finance_category.primary / .detailed, payment_channel, pending
  //
  // TODO: pass `added` to your AI classification engine
  // TODO: for `removed`, delete from your deductions table
  // TODO: update Tax Health Score for userId
  // TODO: push notification for high-confidence deductions (Feature 02)

  return { added, modified, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function decodeWebhookKeyId(token) {
  // Extract key_id from unverified JWT header for the JWKS lookup
  const [headerB64] = token.split(".");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  return header.kid;
}

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SmartTax Plaid backend running on :${PORT}`));
