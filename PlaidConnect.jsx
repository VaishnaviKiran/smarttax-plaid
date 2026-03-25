import { useState, useCallback, useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";

// ─── SmartTax AI — Plaid Bank Connection (Production) ────────────────────────
// npm install react-plaid-link
//
// Props:
//   userId        (string)   your app's authenticated user ID (from session/JWT)
//   authToken     (string)   your app's JWT — sent in Authorization header
//   onSuccess     (fn)       called with { accounts } after successful connection
//   onExit        (fn)       called if user closes Plaid without connecting
// ─────────────────────────────────────────────────────────────────────────────

export default function PlaidConnect({ userId, authToken, onSuccess, onExit }) {
  const [linkToken, setLinkToken]   = useState(null);
  const [loading, setLoading]       = useState(false);
  const [accounts, setAccounts]     = useState([]);
  const [connected, setConnected]   = useState(false);
  const [error, setError]           = useState(null);

  // Authenticated fetch helper — always sends your app's JWT
  const apiFetch = useCallback(
    (path, options = {}) =>
      fetch(`/api/plaid${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...(options.headers || {}),
        },
      }),
    [authToken]
  );

  // ── Step 1: Fetch link_token on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function fetchLinkToken() {
      try {
        const res = await apiFetch("/create-link-token", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setLinkToken(data.link_token);
      } catch (err) {
        if (!cancelled) setError("Couldn't initialize bank connection. Please try again.");
        console.error("create-link-token:", err);
      }
    }
    fetchLinkToken();
    return () => { cancelled = true; };
  }, [apiFetch]);

  // ── Step 2: Handle Plaid success — exchange public_token ──────────────────
  const handlePlaidSuccess = useCallback(
    async (publicToken, metadata) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch("/exchange-token", {
          method: "POST",
          body: JSON.stringify({ publicToken }),
          // Note: userId is read from your JWT on the backend — never sent in body
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setAccounts(data.accounts);
        setConnected(true);
        onSuccess?.({ accounts: data.accounts });
      } catch (err) {
        setError("Connection failed. Please try again.");
        console.error("exchange-token:", err);
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, onSuccess]
  );

  // ── Step 3: Open Plaid Link ────────────────────────────────────────────────
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: handlePlaidSuccess,
    onExit: (err, metadata) => {
      if (err?.error_code) setError(err.display_message || "Bank connection closed.");
      onExit?.({ err, metadata });
    },
    onEvent: (eventName, metadata) => {
      // Wire to your analytics: analytics.track("plaid_link_event", { eventName, ...metadata })
    },
  });

  if (connected) return <ConnectedState accounts={accounts} />;

  const btnDisabled = !ready || loading || !linkToken;

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <div style={styles.boostBadge}>+15 Tax Health Score</div>
        <div style={styles.icon}>🏦</div>
        <h2 style={styles.heading}>Connect your bank</h2>
        <p style={styles.subtext}>
          SmartTax finds deductions the second you spend — automatically.
          Connecting takes under 30 seconds and uses bank-level encryption.
        </p>
        <div style={styles.banks}>
          {["Chase", "BofA", "Wells Fargo", "Chime", "Mercury", "Novo"].map((b) => (
            <span key={b} style={styles.bankChip}>{b}</span>
          ))}
          <span style={styles.bankChip}>+ 12,000 more</span>
        </div>
        {error && <div style={styles.errorBox}>{error}</div>}
        <button
          style={{ ...styles.ctaBtn, opacity: btnDisabled ? 0.6 : 1, cursor: btnDisabled ? "not-allowed" : "pointer" }}
          onClick={() => open()}
          disabled={btnDisabled}
        >
          {loading ? "Connecting…" : !linkToken ? "Loading…" : "Connect my bank →"}
        </button>
        <p style={styles.securityNote}>
          🔒 Powered by Plaid · Read-only access · We never see your login
        </p>
      </div>
    </div>
  );
}

function ConnectedState({ accounts }) {
  return (
    <div style={styles.wrapper}>
      <div style={{ ...styles.card, borderColor: "#22c55e" }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
        <h2 style={{ ...styles.heading, color: "#22c55e" }}>Bank connected!</h2>
        <div style={{ ...styles.boostBadge, background: "#22c55e" }}>
          +15 points added to your Tax Health Score
        </div>
        <p style={styles.subtext}>
          We're scanning your last 90 days and finding deductions now.
        </p>
        <div style={styles.accountList}>
          {accounts.map((acct) => (
            <div key={acct.account_id} style={styles.accountRow}>
              <div>
                <div style={styles.accountName}>{acct.name}</div>
                <div style={styles.accountSub}>
                  {acct.subtype?.toUpperCase()} · ••••{acct.mask}
                </div>
              </div>
              <div style={styles.accountBalance}>
                {acct.balances?.current != null
                  ? `$${acct.balances.current.toLocaleString()}`
                  : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles = {
  wrapper: { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#0a0a0f", fontFamily: "'DM Sans', system-ui, sans-serif", padding: 24 },
  card: { background: "#13131a", border: "1px solid #2a2a3a", borderRadius: 20, padding: "40px 36px", maxWidth: 420, width: "100%", textAlign: "center", boxShadow: "0 0 60px rgba(99,102,241,0.08)" },
  boostBadge: { display: "inline-block", background: "#6366f1", color: "#fff", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", padding: "4px 12px", borderRadius: 99, marginBottom: 20, textTransform: "uppercase" },
  icon: { fontSize: 48, marginBottom: 12 },
  heading: { color: "#f0f0ff", fontSize: 26, fontWeight: 700, margin: "0 0 12px" },
  subtext: { color: "#8888aa", fontSize: 15, lineHeight: 1.6, margin: "0 0 24px" },
  banks: { display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 28 },
  bankChip: { background: "#1e1e2e", border: "1px solid #2a2a3a", color: "#9999bb", fontSize: 12, borderRadius: 6, padding: "4px 10px" },
  ctaBtn: { width: "100%", padding: "16px 24px", background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)", color: "#fff", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", marginBottom: 16 },
  securityNote: { color: "#555577", fontSize: 12, margin: 0 },
  errorBox: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", borderRadius: 10, padding: "12px 16px", fontSize: 13, marginBottom: 16 },
  accountList: { marginTop: 20, textAlign: "left", display: "flex", flexDirection: "column", gap: 10 },
  accountRow: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#1a1a2e", borderRadius: 10, padding: "12px 16px" },
  accountName: { color: "#e0e0ff", fontSize: 14, fontWeight: 600 },
  accountSub: { color: "#6666aa", fontSize: 12, marginTop: 2 },
  accountBalance: { color: "#a0a0cc", fontSize: 14, fontWeight: 700 },
};
