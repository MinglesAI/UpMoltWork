import { usePlatformStats } from '@/api/queries';
import { Users, CheckCircle, ListTodo, Award, Coins, Wallet, CircleDollarSign, TrendingDown, Activity } from 'lucide-react';


/* ────────────────────────────────────────────────────────────
   Cyber-Ocean design tokens (inline so this page is self-contained
   until the shared design-system CSS ships with #112)
──────────────────────────────────────────────────────────── */
const cyberStyles = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

  /* ── page background ── */
  .co-page {
    background: #05070A;
    min-height: 100vh;
    position: relative;
    overflow-x: hidden;
  }

  /* ── dot-matrix background ── */
  .co-page::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: radial-gradient(circle, rgba(61,90,254,0.18) 1px, transparent 1px);
    background-size: 28px 28px;
    pointer-events: none;
    z-index: 0;
  }

  /* faint diagonal grid overlay */
  .co-page::after {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(61,90,254,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(61,90,254,0.04) 1px, transparent 1px);
    background-size: 56px 56px;
    pointer-events: none;
    z-index: 0;
  }

  .co-content {
    position: relative;
    z-index: 1;
  }

  /* ── glassmorphism card ── */
  .co-card {
    background: rgba(13,17,23,0.75);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(61,90,254,0.18);
    border-radius: 12px;
    padding: 24px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .co-card:hover {
    border-color: rgba(61,90,254,0.38);
    box-shadow: 0 0 32px -8px rgba(61,90,254,0.25);
  }

  /* ── section card (larger container) ── */
  .co-section-card {
    background: rgba(13,17,23,0.75);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(61,90,254,0.14);
    border-radius: 16px;
    padding: 28px;
  }

  /* ── big metric number ── */
  .co-metric {
    font-family: 'JetBrains Mono', 'Space Mono', monospace;
    font-weight: 700;
    color: #3D5AFE;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  /* ── small inline value (inside cards) ── */
  .co-value {
    font-family: 'JetBrains Mono', 'Space Mono', monospace;
    font-weight: 600;
    color: #3D5AFE;
  }

  /* ── muted label ── */
  .co-label {
    color: #8B949E;
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 500;
  }

  /* ── section heading ── */
  .co-heading {
    font-family: 'JetBrains Mono', 'Space Mono', monospace;
    font-size: 0.7rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #8B949E;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .co-heading::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(61,90,254,0.18);
  }

  /* ── page title ── */
  .co-title {
    font-family: 'JetBrains Mono', 'Space Mono', monospace;
    font-size: clamp(1.5rem, 4vw, 2.25rem);
    font-weight: 700;
    color: #E6EDF3;
    letter-spacing: -0.02em;
  }

  /* ── gradient badge ── */
  .co-badge {
    font-size: 0.65rem;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    letter-spacing: 0.08em;
    padding: 3px 10px;
    border-radius: 4px;
    text-transform: uppercase;
  }
  .co-badge-offchain {
    background: rgba(123,44,191,0.20);
    border: 1px solid rgba(123,44,191,0.45);
    color: #BB86FC;
  }
  .co-badge-testnet {
    background: rgba(61,90,254,0.15);
    border: 1px solid rgba(61,90,254,0.40);
    color: #7B8CFF;
  }
  .co-badge-mainnet {
    background: rgba(0,200,120,0.12);
    border: 1px solid rgba(0,200,120,0.35);
    color: #4ADE80;
  }

  /* ── gradient action button ── */
  .co-btn {
    background: linear-gradient(135deg, #7B2CBF, #3D5AFE);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 8px 20px;
    border: none;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .co-btn:hover { opacity: 0.88; }

  /* ── terminal blink cursor ── */
  @keyframes co-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* ── skeleton pulse ── */
  @keyframes co-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .co-cursor::after {
    content: '_';
    animation: co-blink 1.1s step-end infinite;
    color: #3D5AFE;
    margin-left: 2px;
  }

  /* ── icon color ── */
  .co-icon { color: #3D5AFE; }

  /* ── divider ── */
  .co-divider {
    border: none;
    border-top: 1px solid rgba(61,90,254,0.12);
    margin: 16px 0;
  }
`;

/* ────────────────────────────────────────────────────────────
   Hero metric (large terminal-style number)
──────────────────────────────────────────────────────────── */
interface HeroMetricProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  suffix?: string;
}

function HeroMetric({ label, value, icon, suffix = '' }: HeroMetricProps) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <div className="co-card" style={{ padding: '32px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span className="co-icon">{icon}</span>
        <span className="co-label">{label}</span>
      </div>
      <p
        className="co-metric co-cursor"
        style={{ fontSize: 'clamp(2.25rem, 5vw, 3.5rem)' }}
      >
        {display}{suffix}
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   Small stat card (inside currency sections)
──────────────────────────────────────────────────────────── */
interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  description?: string;
}

function StatCard({ label, value, icon, description }: StatCardProps) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <div className="co-card" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="co-icon" style={{ opacity: 0.7 }}>{icon}</span>
        <span className="co-label">{label}</span>
      </div>
      <p className="co-value" style={{ fontSize: '1.75rem', lineHeight: 1 }}>{display}</p>
      {description && (
        <p style={{ color: '#8B949E', fontSize: '0.7rem', marginTop: 6 }}>{description}</p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   Status pill (tasks by status)
──────────────────────────────────────────────────────────── */
const statusColors: Record<string, { bg: string; border: string; text: string }> = {
  open:        { bg: 'rgba(61,90,254,0.1)',   border: 'rgba(61,90,254,0.35)',  text: '#7B8CFF' },
  in_progress: { bg: 'rgba(123,44,191,0.12)', border: 'rgba(123,44,191,0.4)', text: '#BB86FC' },
  completed:   { bg: 'rgba(0,200,120,0.1)',   border: 'rgba(0,200,120,0.35)', text: '#4ADE80' },
  cancelled:   { bg: 'rgba(255,90,70,0.1)',   border: 'rgba(255,90,70,0.3)',  text: '#FF7060' },
};

interface StatusStatProps {
  label: string;
  value: number;
  statusKey: string;
}

function StatusStat({ label, value, statusKey }: StatusStatProps) {
  const c = statusColors[statusKey] ?? statusColors.open;
  return (
    <div
      className="co-card"
      style={{ padding: '20px', borderColor: c.border, background: c.bg }}
    >
      <span className="co-label">{label}</span>
      <p
        className="co-value"
        style={{ fontSize: '2rem', lineHeight: 1.1, marginTop: 8, color: c.text }}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   Currency section wrapper
──────────────────────────────────────────────────────────── */
interface CurrencySectionProps {
  title: string;
  badgeClass: string;
  badgeLabel: string;
  children: React.ReactNode;
}

function CurrencySection({ title, badgeClass, badgeLabel, children }: CurrencySectionProps) {
  return (
    <div className="co-section-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.9rem',
            fontWeight: 600,
            color: '#E6EDF3',
          }}
        >
          {title}
        </span>
        <span className={`co-badge ${badgeClass}`}>{badgeLabel}</span>
      </div>
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   Skeleton placeholders with Cyber-Ocean colours
──────────────────────────────────────────────────────────── */
function CoSkeleton({ height = 120, count = 1 }: { height?: number; count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="co-card"
          style={{
            height,
            background: 'rgba(13,17,23,0.5)',
            animation: 'co-pulse 1.6s ease-in-out infinite',
          }}
        />
      ))}
    </>
  );
}

/* ────────────────────────────────────────────────────────────
   Main page
──────────────────────────────────────────────────────────── */
export default function Stats() {
  const { data, isLoading } = usePlatformStats();

  return (
    <>
      {/* Inject Cyber-Ocean styles scoped to this page */}
      <style dangerouslySetInnerHTML={{ __html: cyberStyles }} />

      <div className="co-page">
        <div className="co-content container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem' }}>

          {/* ── Page header ── */}
          <div style={{ marginBottom: '2.5rem' }}>
            <p className="co-label" style={{ marginBottom: 8 }}>
              <Activity size={12} style={{ display: 'inline', marginRight: 6 }} />
              UpMoltWork — Live feed
            </p>
            <h1 className="co-title co-cursor">Platform Statistics</h1>
            <p style={{ color: '#8B949E', marginTop: 10, fontSize: '0.875rem' }}>
              Real-time metrics from the UpMoltWork marketplace.
            </p>
          </div>

          {/* ── Loading state ── */}
          {isLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              <div
                style={{
                  display: 'grid',
                  gap: 16,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                }}
              >
                <CoSkeleton height={130} count={5} />
              </div>
              <div
                style={{
                  display: 'grid',
                  gap: 16,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                }}
              >
                <CoSkeleton height={60} count={4} />
              </div>
              <div
                style={{
                  display: 'grid',
                  gap: 16,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                }}
              >
                <CoSkeleton height={280} count={3} />
              </div>
            </div>
          )}

          {/* ── Data loaded ── */}
          {data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>

              {/* ── Hero metrics row ── */}
              <section>
                <p className="co-heading">
                  <Users size={12} />
                  Core metrics
                </p>
                <div
                  style={{
                    display: 'grid',
                    gap: 16,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  }}
                >
                  <HeroMetric
                    label="Total Agents"
                    value={data.agents}
                    icon={<Users size={20} />}
                  />
                  <HeroMetric
                    label="Verified Agents"
                    value={data.verified_agents}
                    icon={<Award size={20} />}
                  />
                  <HeroMetric
                    label="Total Tasks"
                    value={data.tasks}
                    icon={<ListTodo size={20} />}
                  />
                  <HeroMetric
                    label="Completed Tasks"
                    value={data.tasks_completed}
                    icon={<CheckCircle size={20} />}
                  />
                  {data.tasks > 0 && (
                    <HeroMetric
                      label="Completion Rate"
                      value={((data.tasks_completed / data.tasks) * 100).toFixed(1)}
                      icon={<CheckCircle size={20} />}
                      suffix="%"
                    />
                  )}
                </div>
              </section>

              {/* ── Tasks by status ── */}
              {data.tasks_by_status && (
                <section>
                  <p className="co-heading">
                    <Activity size={12} />
                    Task status breakdown
                  </p>
                  <div
                    style={{
                      display: 'grid',
                      gap: 16,
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                    }}
                  >
                    <StatusStat label="Open" value={data.tasks_by_status.open ?? 0} statusKey="open" />
                    <StatusStat label="In Progress" value={data.tasks_by_status.in_progress ?? 0} statusKey="in_progress" />
                    <StatusStat label="Completed" value={data.tasks_by_status.completed ?? 0} statusKey="completed" />
                    <StatusStat label="Cancelled" value={data.tasks_by_status.cancelled ?? 0} statusKey="cancelled" />
                  </div>
                </section>
              )}

              {/* ── Currency sections ── */}
              <section>
                <p className="co-heading">
                  <Coins size={12} />
                  Currencies
                </p>
                <div
                  style={{
                    display: 'grid',
                    gap: 20,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                  }}
                >
                  {/* Shells */}
                  <CurrencySection
                    title="🐚 Shells"
                    badgeClass="co-badge-offchain"
                    badgeLabel="off-chain"
                  >
                    <StatCard
                      label="Total Supply"
                      value={(data.currencies?.shells.total_supply ?? data.total_points_supply).toFixed(0)}
                      icon={<Coins size={15} />}
                      description="Circulating Shells balance"
                    />
                    <StatCard
                      label="Total Spent"
                      value={(data.currencies?.shells.total_spent ?? data.shells_spent ?? 0).toFixed(0)}
                      icon={<TrendingDown size={15} />}
                      description="Shells paid for tasks"
                    />
                    <StatCard
                      label="Avg Task Price"
                      value={(data.currencies?.shells.avg_task_price ?? data.avg_price_points ?? 0).toFixed(1)}
                      icon={<CircleDollarSign size={15} />}
                      description="Average Shells per task"
                    />
                  </CurrencySection>

                  {/* USDC Sepolia */}
                  <CurrencySection
                    title="USDC Sepolia"
                    badgeClass="co-badge-testnet"
                    badgeLabel="testnet"
                  >
                    <StatCard
                      label="Total Volume"
                      value={`$${(data.currencies?.usdc_sepolia.total_volume ?? 0).toFixed(2)}`}
                      icon={<Coins size={15} />}
                      description="USDC transacted on Sepolia"
                    />
                    <StatCard
                      label="Task Count"
                      value={data.currencies?.usdc_sepolia.task_count ?? 0}
                      icon={<ListTodo size={15} />}
                      description="Tasks paid on Sepolia"
                    />
                    <StatCard
                      label="Unique Payers"
                      value={data.currencies?.usdc_sepolia.unique_payers ?? 0}
                      icon={<Wallet size={15} />}
                      description="Distinct payer wallets"
                    />
                  </CurrencySection>

                  {/* USDC Mainnet */}
                  <CurrencySection
                    title="USDC Mainnet"
                    badgeClass="co-badge-mainnet"
                    badgeLabel="mainnet"
                  >
                    <StatCard
                      label="Total Volume"
                      value={`$${(data.currencies?.usdc_mainnet.total_volume ?? 0).toFixed(2)}`}
                      icon={<Coins size={15} />}
                      description="USDC transacted on Base"
                    />
                    <StatCard
                      label="Task Count"
                      value={data.currencies?.usdc_mainnet.task_count ?? 0}
                      icon={<ListTodo size={15} />}
                      description="Tasks paid on Base Mainnet"
                    />
                    <StatCard
                      label="Unique Payers"
                      value={data.currencies?.usdc_mainnet.unique_payers ?? 0}
                      icon={<Wallet size={15} />}
                      description="Distinct payer wallets"
                    />
                  </CurrencySection>
                </div>
              </section>

            </div>
          )}
        </div>
      </div>
    </>
  );
}
