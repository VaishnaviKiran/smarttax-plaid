import { useState, useEffect, useCallback, useRef } from "react";

// ─── SmartTax AI — Live Deduction Dashboard ───────────────────────────────────
// Reads from: GET /api/deductions/summary  GET /api/deductions/pending
// Writes to:  POST /api/deductions/:id/confirm  POST /api/deductions/:id/reject
//
// Props:
//   authToken  (string) — your app JWT
//   userId     (string)
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_TIERS = [
  { max: 40,  label: "At Risk",      color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  { max: 65,  label: "Getting There",color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  { max: 85,  label: "On Track",     color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  { max: 100, label: "Tax Ready",    color: "#10b981", bg: "rgba(16,185,129,0.12)" },
];

function getTier(score) {
  return SCORE_TIERS.find((t) => score <= t.max) || SCORE_TIERS[3];
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard({ authToken, userId }) {
  const [summary, setSummary]       = useState(null);
  const [pending, setPending]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [savingsAnim, setSavingsAnim] = useState(false);
  const [scoreAnim, setScoreAnim]   = useState(false);
  const [celebration, setCelebration] = useState(null);
  const [streak, setStreak]         = useState(7); // pulled from /api/engagement in real app
  const prevSavings                 = useRef(0);
  const prevScore                   = useRef(0);

  const apiFetch = useCallback((path, opts = {}) =>
    fetch(`/api${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}`, ...(opts.headers || {}) },
    }), [authToken]
  );

  const loadData = useCallback(async () => {
    try {
      const [sumRes, pendRes] = await Promise.all([
        apiFetch("/deductions/summary"),
        apiFetch("/deductions/pending"),
      ]);
      const sumData  = await sumRes.json();
      const pendData = await pendRes.json();

      // Animate if numbers changed
      if (prevSavings.current && sumData.totalSavings > prevSavings.current) setSavingsAnim(true);
      if (prevScore.current   && sumData.score       > prevScore.current)   setScoreAnim(true);

      // Milestone check
      checkMilestone(sumData.totalSavings, prevSavings.current);
      prevSavings.current = sumData.totalSavings;
      prevScore.current   = sumData.score;

      setSummary(sumData);
      setPending(pendData.pending || []);
    } catch (err) {
      console.error("Dashboard load error:", err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadData();
    // Poll every 30s for real-time feel (replace with WebSocket in production)
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    if (savingsAnim) setTimeout(() => setSavingsAnim(false), 1200);
    if (scoreAnim)   setTimeout(() => setScoreAnim(false), 1200);
  }, [savingsAnim, scoreAnim]);

  const checkMilestone = (newTotal, oldTotal) => {
    const milestones = [1000, 5000, 10000, 25000];
    for (const m of milestones) {
      if (oldTotal < m && newTotal >= m) {
        setCelebration({ amount: m });
        setTimeout(() => setCelebration(null), 4000);
        break;
      }
    }
  };

  const handleConfirm = async (txId) => {
    setPending((p) => p.filter((t) => t.plaid_transaction_id !== txId));
    await apiFetch(`/deductions/${txId}/confirm`, { method: "POST" });
    await loadData();
  };

  const handleReject = async (txId) => {
    setPending((p) => p.filter((t) => t.plaid_transaction_id !== txId));
    await apiFetch(`/deductions/${txId}/reject`, { method: "POST" });
    await loadData();
  };

  if (loading) return <LoadingState />;

  const tier  = getTier(summary?.score || 0);
  const score = summary?.score || 0;

  return (
    <div style={S.root}>
      <style>{ANIMATIONS}</style>

      {/* Milestone celebration overlay */}
      {celebration && <MilestoneCelebration amount={celebration.amount} />}

      {/* Header */}
      <div style={S.header}>
        <div>
          <div style={S.appName}>SmartTax AI</div>
          <div style={S.tagline}>Your money, tracked.</div>
        </div>
        <div style={S.streakBadge}>
          <span style={{ fontSize: 18 }}>🔥</span>
          <span style={S.streakNum}>{streak}</span>
          <span style={S.streakLabel}>day streak</span>
        </div>
      </div>

      {/* Tax Health Score */}
      <div style={{ ...S.scoreCard, borderColor: tier.color, background: tier.bg }}>
        <div style={S.scoreRow}>
          <div>
            <div style={S.scoreLabel}>Tax Health Score</div>
            <div style={{ ...S.scoreNum, color: tier.color, animation: scoreAnim ? "scoreUp 0.6s ease" : "none" }}>
              {score}
            </div>
            <div style={{ ...S.scoreTier, color: tier.color }}>{tier.label}</div>
          </div>
          <ScoreRing score={score} color={tier.color} />
        </div>
        <div style={S.scoreAction}>
          {pending.length > 0
            ? `Review ${pending.length} pending deduction${pending.length > 1 ? "s" : ""} — takes under a minute`
            : "You're on top of it. Check back after your next spend."}
        </div>
      </div>

      {/* Total savings — the big number */}
      <div style={S.savingsCard}>
        <div style={S.savingsLabel}>Total deductions found this year</div>
        <div style={{ ...S.savingsNum, animation: savingsAnim ? "countUp 0.8s ease" : "none" }}>
          ${(summary?.totalSavings || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </div>
        <div style={S.savingsSub}>estimated tax savings · only goes up 📈</div>
      </div>

      {/* Pending transaction cards */}
      {pending.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionHeader}>
            <span style={S.sectionTitle}>Review these deductions</span>
            <span style={S.sectionBadge}>{pending.length}</span>
          </div>
          <div style={S.cardStack}>
            {pending.slice(0, 5).map((tx) => (
              <TransactionCard
                key={tx.plaid_transaction_id}
                tx={tx}
                onConfirm={() => handleConfirm(tx.plaid_transaction_id)}
                onReject={() => handleReject(tx.plaid_transaction_id)}
              />
            ))}
            {pending.length > 5 && (
              <div style={S.moreCard}>+{pending.length - 5} more waiting</div>
            )}
          </div>
        </div>
      )}

      {/* Category breakdown */}
      {summary?.categories?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>Deductions by category</div>
          <div style={S.categoryList}>
            {summary.categories.map((cat) => (
              <CategoryRow key={cat.category} cat={cat} total={summary.totalSavings} />
            ))}
          </div>
        </div>
      )}

      {/* Export CTA */}
      <a href="/api/deductions/export" style={S.exportBtn}>
        Export for CPA (CSV) ↓
      </a>
    </div>
  );
}

// ─── Transaction Review Card ──────────────────────────────────────────────────
function TransactionCard({ tx, onConfirm, onReject }) {
  const merchant = tx.merchant_name || tx.name;
  const conf     = Math.round((tx.confidence_score || 0) * 100);
  const savings  = parseFloat(tx.deduction_amount || 0).toFixed(2);

  return (
    <div style={S.txCard}>
      <div style={S.txTop}>
        <div style={S.txMerchant}>{merchant}</div>
        <div style={S.txAmount}>${parseFloat(tx.amount).toFixed(2)}</div>
      </div>
      <div style={S.txMeta}>
        <span style={S.txCategory}>{tx.deduction_category}</span>
        <span style={S.txConf}>{conf}% confident</span>
      </div>
      <div style={S.txSavings}>
        Saves you <strong style={{ color: "#22c55e" }}>${savings}</strong> in taxes
      </div>
      <div style={S.txActions}>
        <button style={S.confirmBtn} onClick={onConfirm}>✓ Yes, it's business</button>
        <button style={S.rejectBtn}  onClick={onReject}>✕ Personal</button>
      </div>
    </div>
  );
}

// ─── Score Ring SVG ───────────────────────────────────────────────────────────
function ScoreRing({ score, color }) {
  const r = 36, c = 2 * Math.PI * r;
  const filled = c * (score / 100);
  return (
    <svg width="90" height="90" viewBox="0 0 90 90">
      <circle cx="45" cy="45" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
      <circle cx="45" cy="45" r={r} fill="none" stroke={color} strokeWidth="8"
        strokeDasharray={`${filled} ${c}`} strokeLinecap="round"
        transform="rotate(-90 45 45)" style={{ transition: "stroke-dasharray 1s ease" }} />
      <text x="45" y="50" textAnchor="middle" fill={color} fontSize="18" fontWeight="700"
        fontFamily="'DM Mono', monospace">{score}</text>
    </svg>
  );
}

// ─── Category Row ─────────────────────────────────────────────────────────────
function CategoryRow({ cat, total }) {
  const pct    = total > 0 ? (cat.tax_savings / total) * 100 : 0;
  const savings = parseFloat(cat.tax_savings || 0).toFixed(2);
  return (
    <div style={S.catRow}>
      <div style={S.catInfo}>
        <div style={S.catName}>{cat.category}</div>
        <div style={S.catCount}>{cat.count} transactions</div>
      </div>
      <div style={S.catRight}>
        <div style={S.catSavings}>${savings}</div>
        <div style={S.catBar}>
          <div style={{ ...S.catBarFill, width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>
    </div>
  );
}

// ─── Milestone Celebration ────────────────────────────────────────────────────
function MilestoneCelebration({ amount }) {
  return (
    <div style={S.celebration}>
      <div style={S.celebInner}>
        <div style={{ fontSize: 52, marginBottom: 8 }}>🎉</div>
        <div style={S.celebTitle}>${amount.toLocaleString()} in deductions!</div>
        <div style={S.celebSub}>You're officially better at taxes than most freelancers.</div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{ ...S.root, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#6666aa", fontSize: 15 }}>Loading your deductions…</div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root: { background: "#09090f", minHeight: "100vh", color: "#f0f0ff",
    fontFamily: "'DM Sans', system-ui, sans-serif", padding: "24px 20px", maxWidth: 480, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
  appName: { fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em", color: "#f0f0ff" },
  tagline: { fontSize: 12, color: "#555577", marginTop: 2 },
  streakBadge: { display: "flex", alignItems: "center", gap: 5, background: "#1a1a2e",
    border: "1px solid #2a2a3a", borderRadius: 99, padding: "6px 14px" },
  streakNum: { fontSize: 18, fontWeight: 800, color: "#f59e0b" },
  streakLabel: { fontSize: 11, color: "#888", marginTop: 1 },

  scoreCard: { borderRadius: 16, border: "1px solid", padding: "20px 22px", marginBottom: 16 },
  scoreRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  scoreLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#777799", marginBottom: 4 },
  scoreNum: { fontSize: 52, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1, fontFamily: "'DM Mono', monospace" },
  scoreTier: { fontSize: 13, fontWeight: 700, marginTop: 4 },
  scoreAction: { fontSize: 13, color: "#9999bb", lineHeight: 1.5 },

  savingsCard: { background: "linear-gradient(135deg, #0f1729 0%, #0d1f1a 100%)",
    border: "1px solid rgba(34,197,94,0.2)", borderRadius: 16, padding: "22px",
    marginBottom: 24, textAlign: "center" },
  savingsLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
    color: "#4a8a6a", marginBottom: 8 },
  savingsNum: { fontSize: 42, fontWeight: 800, color: "#22c55e", letterSpacing: "-0.03em",
    fontFamily: "'DM Mono', monospace" },
  savingsSub: { fontSize: 12, color: "#3a7a5a", marginTop: 6 },

  section: { marginBottom: 28 },
  sectionHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  sectionTitle: { fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#666688" },
  sectionBadge: { background: "#6366f1", color: "#fff", fontSize: 11, fontWeight: 700,
    borderRadius: 99, padding: "2px 8px" },

  cardStack: { display: "flex", flexDirection: "column", gap: 10 },
  txCard: { background: "#13131f", border: "1px solid #2a2a3a", borderRadius: 14, padding: "16px 18px" },
  txTop: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  txMerchant: { fontSize: 15, fontWeight: 700, color: "#e0e0ff" },
  txAmount: { fontSize: 15, fontWeight: 700, color: "#9999bb" },
  txMeta: { display: "flex", gap: 10, marginBottom: 8 },
  txCategory: { fontSize: 11, background: "rgba(99,102,241,0.15)", color: "#818cf8",
    borderRadius: 6, padding: "2px 8px", fontWeight: 600 },
  txConf: { fontSize: 11, color: "#555577" },
  txSavings: { fontSize: 13, color: "#9999bb", marginBottom: 14 },
  txActions: { display: "flex", gap: 10 },
  confirmBtn: { flex: 1, padding: "11px", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)",
    color: "#22c55e", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  rejectBtn: { flex: 1, padding: "11px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
    color: "#f87171", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  moreCard: { textAlign: "center", padding: "14px", color: "#555577", fontSize: 13,
    border: "1px dashed #2a2a3a", borderRadius: 12 },

  categoryList: { display: "flex", flexDirection: "column", gap: 10 },
  catRow: { display: "flex", justifyContent: "space-between", alignItems: "center",
    background: "#111120", borderRadius: 12, padding: "14px 16px" },
  catInfo: {},
  catName: { fontSize: 13, fontWeight: 600, color: "#d0d0ee", marginBottom: 2 },
  catCount: { fontSize: 11, color: "#555577" },
  catRight: { textAlign: "right" },
  catSavings: { fontSize: 14, fontWeight: 700, color: "#22c55e", marginBottom: 4 },
  catBar: { width: 80, height: 3, background: "#1e1e2e", borderRadius: 99 },
  catBarFill: { height: "100%", background: "#6366f1", borderRadius: 99, transition: "width 0.6s ease" },

  exportBtn: { display: "block", textAlign: "center", padding: "14px",
    background: "transparent", border: "1px solid #2a2a3a", borderRadius: 12,
    color: "#555577", fontSize: 13, textDecoration: "none", marginTop: 8 },

  celebration: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999,
    animation: "fadeIn 0.3s ease" },
  celebInner: { textAlign: "center", padding: 40 },
  celebTitle: { fontSize: 32, fontWeight: 800, color: "#22c55e", marginBottom: 10 },
  celebSub: { fontSize: 15, color: "#9999bb" },
};

const ANIMATIONS = `
  @keyframes countUp {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.06); color: #4ade80; }
    100% { transform: scale(1); }
  }
  @keyframes scoreUp {
    0%   { transform: scale(1); }
    40%  { transform: scale(1.1); }
    100% { transform: scale(1); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
`;
