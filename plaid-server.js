require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const {
  PlaidApi,
  PlaidEnvironments,
  Configuration,
  Products,
  CountryCode,
  WebhookType,
} = require("plaid");

const app = express();
const PORT = process.env.PORT || 3001;

let ACCESS_TOKEN = null;
let ITEM_ID = null;

// Webhook route must be mounted before express.json()
app.use("/api/plaid/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.use(
  cors({
    origin: "http://localhost:3000",
  })
);

// Database
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
      "Plaid-Version": "2020-09-14",
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// Optional auth middleware
function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = payload.sub || payload.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Create link token
app.post("/api/plaid/create-link-token", async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: "test-user-123" },
      client_name: "SmartTax AI",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      webhook: process.env.PLAID_WEBHOOK_URL,
    });

    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error(
      "CREATE LINK TOKEN ERROR:",
      error.response?.data || error.message || error
    );
    res.status(500).json({
      error: "Failed to create link token",
      details: error.response?.data || error.message || "Unknown error",
    });
  }
});

// Exchange public token
app.post("/api/plaid/exchange_public_token", async (req, res) => {
  try {
    console.log("exchange route hit");
    console.log("req.body:", req.body);

    const { public_token } = req.body;

    if (!public_token) {
      return res
        .status(400)
        .json({ error: "public_token is missing from request body" });
    }

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    ACCESS_TOKEN = response.data.access_token;
    ITEM_ID = response.data.item_id;

    await db.query(
      `
      INSERT INTO plaid_items (user_id, access_token, item_id, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (item_id)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        updated_at = NOW()
      `,
      ["test-user-123", ACCESS_TOKEN, ITEM_ID]
    );

    console.log("ACCESS_TOKEN saved:", ACCESS_TOKEN);
    console.log("ITEM_ID saved:", ITEM_ID);
    console.log("Saved Plaid item in DB");

    res.json({
      success: true,
      item_id: ITEM_ID,
    });
  } catch (error) {
    console.error(
      "EXCHANGE TOKEN ERROR FULL:",
      error.response?.data || error.message || error
    );
    res.status(500).json({
      error: "Failed to exchange token",
      details: error.response?.data || error.message || "Unknown error",
    });
  }
});

// Get accounts
app.get("/api/plaid/accounts", async (req, res) => {
  try {
    console.log("accounts route hit");
    console.log("ACCESS_TOKEN value:", ACCESS_TOKEN);

    if (!ACCESS_TOKEN) {
      return res
        .status(400)
        .json({ error: "No access token found. Connect bank first." });
    }

    const response = await plaidClient.accountsGet({
      access_token: ACCESS_TOKEN,
    });

    console.log("accounts success:", response.data);
    res.json(response.data);
  } catch (error) {
    console.error(
      "ACCOUNTS ERROR FULL:",
      error.response?.data || error.message || error
    );
    res.status(500).json({
      error: "Failed to fetch accounts",
      details: error.response?.data || error.message || "Unknown error",
    });
  }
});

// Get transactions
app.get("/api/plaid/transactions", async (req, res) => {
  try {
    console.log("transactions route hit");
    console.log("ACCESS_TOKEN value:", ACCESS_TOKEN);

    if (!ACCESS_TOKEN) {
      return res
        .status(400)
        .json({ error: "No access token found. Connect bank first." });
    }

    const response = await plaidClient.transactionsGet({
      access_token: ACCESS_TOKEN,
      start_date: "2025-01-01",
      end_date: "2026-12-31",
    });

    console.log("transactions success:", response.data);
    res.json(response.data);
  } catch (error) {
    console.error(
      "TRANSACTIONS ERROR FULL:",
      error.response?.data || error.message || error
    );
    res.status(500).json({
      error: "Failed to fetch transactions",
      details: error.response?.data || error.message || "Unknown error",
    });
  }
});

// Test DB
app.get("/api/test-db", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW()");
    res.json({
      success: true,
      result: result.rows,
    });
  } catch (error) {
    console.error("TEST DB ERROR:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Show saved Plaid items
app.get("/api/plaid/db-items", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT user_id, item_id, created_at, updated_at FROM plaid_items ORDER BY updated_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("DB ITEMS ERROR:", error.message);
    res.status(500).json({ error: "Failed to fetch db items" });
  }
});

// Webhook
app.post("/api/plaid/webhook", async (req, res) => {
  const plaidVerificationToken = req.headers["plaid-verification"];

  if (!plaidVerificationToken) {
    return res.status(400).json({ error: "Missing Plaid-Verification header" });
  }

  try {
    await plaidClient.webhookVerificationKeyGet({
      key_id: decodeWebhookKeyId(plaidVerificationToken),
    });
  } catch (error) {
    console.error("Webhook verification failed:", error.message);
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload;

  try {
    payload = JSON.parse(req.body.toString());
  } catch (error) {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const { webhook_type, webhook_code, item_id } = payload;
  console.log(`Plaid webhook: ${webhook_type}/${webhook_code} — item ${item_id}`);

  res.sendStatus(200);

  if (webhook_type === WebhookType.Transactions) {
    const row = await db
      .query(
        "SELECT user_id, access_token FROM plaid_items WHERE item_id = $1",
        [item_id]
      )
      .catch(() => ({ rows: [] }));

    if (!row.rows.length) {
      console.warn(`Webhook for unknown item_id: ${item_id}`);
      return;
    }

    const { user_id, access_token } = row.rows[0];

    if (
      [
        "SYNC_UPDATES_AVAILABLE",
        "DEFAULT_UPDATE",
        "INITIAL_UPDATE",
        "HISTORICAL_UPDATE",
      ].includes(webhook_code)
    ) {
      syncTransactions(user_id, access_token, item_id).catch((error) =>
        console.error(`Webhook sync failed for ${user_id}:`, error.message)
      );
    }
  }

  if (webhook_type === "ITEM" && webhook_code === "ERROR") {
    console.warn(`Item error for ${item_id}:`, payload.error);
  }
});

async function syncTransactions(userId, accessToken, itemId) {
  const cursorRow = await db.query(
    "SELECT cursor FROM plaid_items WHERE item_id = $1",
    [itemId]
  );

  let cursor = cursorRow.rows[0]?.cursor || null;
  const added = [];
  const modified = [];
  const removed = [];
  let hasMore = true;

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      options: { include_personal_finance_category: true },
    });

    added.push(...response.data.added);
    modified.push(...response.data.modified);
    removed.push(...response.data.removed);
    hasMore = response.data.has_more;
    cursor = response.data.next_cursor;
  }

  await db.query(
    "UPDATE plaid_items SET cursor = $1, updated_at = NOW() WHERE item_id = $2",
    [cursor, itemId]
  );

  console.log(
    `[${userId}] Sync complete: +${added.length} added, ${modified.length} modified, ${removed.length} removed`
  );

  return { added, modified, removed };
}

function decodeWebhookKeyId(token) {
  const [headerB64] = token.split(".");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  return header.kid;
}

app.listen(PORT, () => {
  console.log(`SmartTax Plaid backend running on :${PORT}`);
});