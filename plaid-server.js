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
let transactionFeedback = {};

// Webhook route must be mounted before express.json()
app.use("/api/plaid/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.use(
  cors({
    origin: ["http://localhost:3000", "http://localhost:8080"],
    credentials: true,
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

function roundToTwo(num) {
  return Math.round(num * 100) / 100;
}

function classifyTransaction(transaction) {
  const merchant = (transaction.merchant_name || transaction.name || "").toLowerCase();

  let category = "other";
  let confidence = 0.35;
  let deductiblePercent = 0;
  const classification_signals = [];

  if (
    merchant.includes("adobe") ||
    merchant.includes("figma") ||
    merchant.includes("canva") ||
    merchant.includes("notion") ||
    merchant.includes("slack") ||
    merchant.includes("github") ||
    merchant.includes("aws") ||
    merchant.includes("zoom") ||
    merchant.includes("google workspace") ||
    merchant.includes("dropbox") ||
    merchant.includes("chatgpt") ||
    merchant.includes("linkedin premium") ||
    merchant.includes("shopify") ||
    merchant.includes("quickbooks") ||
    merchant.includes("squarespace")
  ) {
    category = "software_subscriptions";
    confidence = 0.95;
    deductiblePercent = 1.0;
    classification_signals.push("merchant_match:software_tools", "profile_match:business_tools");
  } else if (
    merchant.includes("office depot") ||
    merchant.includes("staples") ||
    merchant.includes("best buy") ||
    merchant.includes("apple")
  ) {
    category = "equipment_hardware";
    confidence = 0.9;
    deductiblePercent = 1.0;
    classification_signals.push("merchant_match:equipment", "category:hardware");
  } else if (
    merchant.includes("comcast") ||
    merchant.includes("xfinity") ||
    merchant.includes("verizon") ||
    merchant.includes("at&t") ||
    merchant.includes("tmobile") ||
    merchant.includes("t-mobile")
  ) {
    category = "internet_phone";
    confidence = 0.7;
    deductiblePercent = 0.5;
    classification_signals.push("merchant_match:internet_phone", "rule:partial_business_use");
  } else if (
    merchant.includes("uber") ||
    merchant.includes("lyft") ||
    merchant.includes("shell") ||
    merchant.includes("chevron") ||
    merchant.includes("exxon")
  ) {
    category = "travel_transport";
    confidence = 0.72;
    deductiblePercent = 0.7;
    classification_signals.push("merchant_match:transport", "rule:mixed_use_possible");
  } else if (
    merchant.includes("starbucks") ||
    merchant.includes("doordash") ||
    merchant.includes("ubereats") ||
    merchant.includes("chipotle") ||
    merchant.includes("mcdonald")
  ) {
    category = "meals";
    confidence = 0.6;
    deductiblePercent = 0.5;
    classification_signals.push("merchant_match:meals", "irs_rule:50_percent_limit");
  } 
  else if (
  merchant.includes("openai") ||
  merchant.includes("chatgpt")
) {
  category = "software_subscriptions";
  confidence = 0.95;
  deductiblePercent = 1.0;
  classification_signals.push("merchant_match:ai_tools");
} else if (
  merchant.includes("zelle") ||
  merchant.includes("payment") ||
  merchant.includes("transfer") ||
  merchant.includes("ach")
) {
  category = "personal_transfer";
  confidence = 0.2;
  deductiblePercent = 0;
  classification_signals.push("rule:money_transfer_not_deductible");
}else if (
    merchant.includes("walmart") ||
    merchant.includes("target") ||
    merchant.includes("costco") ||
    merchant.includes("grocery") ||
    merchant.includes("whole foods") ||
    merchant.includes("trader joe")
  ) {
    category = "personal";
    confidence = 0.25;
    deductiblePercent = 0;
    classification_signals.push("merchant_match:personal_retail");
  } else {
    category = "other";
    confidence = 0.4;
    deductiblePercent = 0;
    classification_signals.push("merchant_match:unknown");
  }

  let status = "needs_review";
  let user_confirmed = null;
  let is_deductible = false;

  // PDF logic
  if (confidence >= 0.85) {
    status = "confirmed";
    is_deductible = true;
  } else if (confidence >= 0.5) {
    status = "pending";
    is_deductible = true;
  } else {
    status = "needs_review";
    is_deductible = false;
  }

  const deduction_amount = roundToTwo(transaction.amount * deductiblePercent);
  const tax_rate_applied = 0.3;
  const estimated_tax_savings = roundToTwo(deduction_amount * tax_rate_applied);

  return {
    category,
    confidence_score: confidence,
    status,
    is_deductible,
    deductible_label: is_deductible
      ? deductiblePercent === 1
        ? "100% Deductible"
        : "Partially Deductible"
      : "Not Deductible",
    deduction_amount,
    tax_rate_applied,
    estimated_tax_savings,
    user_confirmed,
    classification_signals,
  };
}

async function getSavedAccessToken() {
  if (ACCESS_TOKEN) {
    return ACCESS_TOKEN;
  }

  const result = await db.query(
    `
    SELECT access_token, item_id
    FROM plaid_items
    WHERE user_id = $1
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    ["test-user-123"]
  );

  if (!result.rows.length) {
    return null;
  }

  ACCESS_TOKEN = result.rows[0].access_token;
  ITEM_ID = result.rows[0].item_id;

  return ACCESS_TOKEN;
}

app.get("/", (req, res) => {
  res.send("SmartTax Plaid backend is running");
});

app.get("/api/mock-transactions", async (req, res) => {
  try {
    const mockTransactions = [
      {
        transaction_id: "tx_1",
        name: "Adobe",
        amount: 100,
        merchant_name: "Adobe",
        category: ["Software"],
        date: "2026-04-01",
      },
      {
        transaction_id: "tx_2",
        name: "Starbucks",
        amount: 12,
        merchant_name: "Starbucks",
        category: ["Food and Drink"],
        date: "2026-04-01",
      },
      {
        transaction_id: "tx_3",
        name: "Shell",
        amount: 45,
        merchant_name: "Shell",
        category: ["Transportation"],
        date: "2026-04-01",
      },
      {
        transaction_id: "tx_4",
        name: "Random Store",
        amount: 20,
        merchant_name: "Random Store",
        category: ["Shops"],
        date: "2026-04-01",
      },
    ];

    const enrichedTransactions = mockTransactions.map((transaction) => {
      const classified = classifyTransaction(transaction);
      const feedback = transactionFeedback[transaction.transaction_id];

      let finalStatus = classified.status;
      let user_confirmed = classified.user_confirmed;

      if (feedback) {
        user_confirmed = feedback.user_confirmed;
        finalStatus = feedback.user_confirmed ? "confirmed" : "rejected";
      }

      return {
        ...transaction,
        auto_classification: classified.category,
        confidence_score: classified.confidence_score,
        status: finalStatus,
        deduction_amount: classified.deduction_amount,
        tax_rate_applied: classified.tax_rate_applied,
        estimated_tax_savings: classified.estimated_tax_savings,
        user_confirmed,
        classification_signals: classified.classification_signals,
      };
    });

    res.json({
      success: true,
      transactions: enrichedTransactions,
    });
  } catch (error) {
    console.error("MOCK TRANSACTIONS ERROR:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/transaction-feedback", async (req, res) => {
  try {
    const { transaction_id, user_confirmed } = req.body;

    if (!transaction_id || typeof user_confirmed !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "transaction_id and user_confirmed are required",
      });
    }

    transactionFeedback[transaction_id] = {
      user_confirmed,
      updated_at: new Date().toISOString(),
    };

    res.json({
      success: true,
      message: "Feedback saved successfully",
      feedback: transactionFeedback[transaction_id],
    });
  } catch (error) {
    console.error("TRANSACTION FEEDBACK ERROR:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

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

    const accessToken = await getSavedAccessToken();

    if (!accessToken) {
      return res.status(400).json({
        error: "No access token found. Connect bank first.",
      });
    }

    const response = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    console.log("accounts success:", response.data);

    res.json({
      success: true,
      accounts: response.data.accounts,
      item: response.data.item,
    });
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

    const accessToken = await getSavedAccessToken();

    if (!accessToken) {
      return res.status(400).json({
        error: "No access token found. Connect bank first.",
      });
    }

    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: "2025-01-01",
      end_date: "2026-12-31",
    });

    const enrichedTransactions = response.data.transactions.map((transaction) => {
      const classified = classifyTransaction(transaction);
      const feedback = transactionFeedback[transaction.transaction_id];

      let finalStatus = classified.status;
      let finalDeductible = classified.is_deductible;
      let finalLabel = classified.deductible_label;
      let user_confirmed = classified.user_confirmed;

      if (feedback) {
        user_confirmed = feedback.user_confirmed;

        if (feedback.user_confirmed === true) {
          finalStatus = "confirmed";
          finalDeductible = true;
          finalLabel = classified.deductible_label;
        } else if (feedback.user_confirmed === false) {
          finalStatus = "rejected";
          finalDeductible = false;
          finalLabel = "Not Deductible";
        }
      }

      return {
        transaction_id: transaction.transaction_id,
        name: transaction.name,
        merchant_name: transaction.merchant_name,
        amount: transaction.amount,
        date: transaction.date,
        category: transaction.category,
        auto_classification: classified.category,
        confidence_score: classified.confidence_score,
        status: finalStatus,
        is_deductible: finalDeductible,
        deductible_label: finalLabel,
        deduction_amount: finalDeductible ? classified.deduction_amount : 0,
        tax_rate_applied: classified.tax_rate_applied,
        estimated_tax_savings: finalDeductible ? classified.estimated_tax_savings : 0,
        user_confirmed,
        classification_signals: classified.classification_signals,
      };
    });

    console.log("transactions success:", enrichedTransactions.length);

    res.json({
      success: true,
      total_transactions: response.data.total_transactions,
      transactions: enrichedTransactions,
    });
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
app.get("/reset-bank", async (req, res) => {
  try {
    await db.query("DELETE FROM plaid_items");

    ACCESS_TOKEN = null;
    ITEM_ID = null;

    res.send("Bank reset done ✅");
  } catch (error) {
    console.error(error);
    res.status(500).send("Failed to reset bank");
  }
});

app.listen(PORT, () => {
  console.log(`SmartTax Plaid backend running on :${PORT}`);
});