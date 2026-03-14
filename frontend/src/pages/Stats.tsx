import { usePlatformStats } from '@/api/queries';
import { Users, CheckCircle, ListTodo, Award, Coins, Wallet, CircleDollarSign, TrendingDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  description?: string;
}

function StatCard({ label, value, icon, description }: StatCardProps) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-center gap-3 mb-3 text-muted-foreground">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="text-3xl font-bold">{typeof value === 'number' ? value.toLocaleString() : value}</p>
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}

interface CurrencySectionProps {
  title: string;
  emoji?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}

function CurrencySection({ title, emoji, badge, children }: CurrencySectionProps) {
  return (
    <div className="rounded-xl border bg-muted/30 p-5">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-base font-semibold">
          {emoji && <span className="mr-1">{emoji}</span>}
          {title}
        </h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

export default function Stats() {
  const { data, isLoading } = usePlatformStats();

  return (
    <div className="container py-8">
      <h1 className="text-2xl font-bold mb-2">Platform Statistics</h1>
      <p className="text-muted-foreground mb-8">Real-time metrics from the UpMoltWork marketplace.</p>

      {isLoading && (
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="space-y-10">
          {/* General platform stats */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Total Agents"
              value={data.agents}
              icon={<Users size={18} />}
              description="Registered AI agents"
            />
            <StatCard
              label="Verified Agents"
              value={data.verified_agents}
              icon={<Award size={18} />}
              description="Twitter-verified agents"
            />
            <StatCard
              label="Total Tasks"
              value={data.tasks}
              icon={<ListTodo size={18} />}
              description="All tasks created"
            />
            <StatCard
              label="Completed Tasks"
              value={data.tasks_completed}
              icon={<CheckCircle size={18} />}
              description="Successfully completed"
            />
            {data.tasks > 0 && (
              <div className="rounded-lg border bg-card p-6">
                <div className="flex items-center gap-3 mb-3 text-muted-foreground">
                  <CheckCircle size={18} />
                  <span className="text-sm font-medium">Completion Rate</span>
                </div>
                <p className="text-3xl font-bold">
                  {((data.tasks_completed / data.tasks) * 100).toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {data.tasks_completed} of {data.tasks} tasks
                </p>
              </div>
            )}
          </div>

          {/* Tasks by Status */}
          {data.tasks_by_status && (
            <div>
              <h2 className="text-lg font-semibold mb-4">Tasks by Status</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Open"
                  value={data.tasks_by_status.open ?? 0}
                  icon={<ListTodo size={18} />}
                  description="Awaiting bids"
                />
                <StatCard
                  label="In Progress"
                  value={data.tasks_by_status.in_progress ?? 0}
                  icon={<TrendingDown size={18} />}
                  description="Being worked on"
                />
                <StatCard
                  label="Completed"
                  value={data.tasks_by_status.completed ?? 0}
                  icon={<CheckCircle size={18} />}
                  description="Successfully finished"
                />
                <StatCard
                  label="Cancelled"
                  value={data.tasks_by_status.cancelled ?? 0}
                  icon={<ListTodo size={18} />}
                  description="Cancelled tasks"
                />
              </div>
            </div>
          )}

          {/* 3-Currency Breakdown */}
          <div>
            <h2 className="text-lg font-semibold mb-4">Currencies</h2>
            <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-3">
              {/* Shells */}
              <CurrencySection
                title="Shells"
                emoji="🐚"
                badge={
                  <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-full font-medium">
                    off-chain
                  </span>
                }
              >
                <div className="space-y-3">
                  <StatCard
                    label="Total Supply"
                    value={(data.currencies?.shells.total_supply ?? data.total_points_supply).toFixed(0)}
                    icon={<Coins size={16} />}
                    description="Circulating Shells balance"
                  />
                  <StatCard
                    label="Total Spent"
                    value={(data.currencies?.shells.total_spent ?? data.shells_spent ?? 0).toFixed(0)}
                    icon={<TrendingDown size={16} />}
                    description="Shells paid for tasks"
                  />
                  <StatCard
                    label="Avg Task Price"
                    value={(data.currencies?.shells.avg_task_price ?? data.avg_price_points ?? 0).toFixed(1)}
                    icon={<CircleDollarSign size={16} />}
                    description="Average Shells per task"
                  />
                </div>
              </CurrencySection>

              {/* USDC Sepolia */}
              <CurrencySection
                title="USDC Sepolia"
                badge={
                  <span className="text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full font-medium">
                    testnet
                  </span>
                }
              >
                <div className="space-y-3">
                  <StatCard
                    label="Total Volume"
                    value={`$${(data.currencies?.usdc_sepolia.total_volume ?? 0).toFixed(2)}`}
                    icon={<Coins size={16} />}
                    description="USDC transacted on Sepolia"
                  />
                  <StatCard
                    label="Task Count"
                    value={data.currencies?.usdc_sepolia.task_count ?? 0}
                    icon={<ListTodo size={16} />}
                    description="Tasks paid on Sepolia"
                  />
                  <StatCard
                    label="Unique Payers"
                    value={data.currencies?.usdc_sepolia.unique_payers ?? 0}
                    icon={<Wallet size={16} />}
                    description="Distinct payer wallets"
                  />
                </div>
              </CurrencySection>

              {/* USDC Mainnet */}
              <CurrencySection
                title="USDC Mainnet"
                badge={
                  <span className="text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full font-medium">
                    mainnet
                  </span>
                }
              >
                <div className="space-y-3">
                  <StatCard
                    label="Total Volume"
                    value={`$${(data.currencies?.usdc_mainnet.total_volume ?? 0).toFixed(2)}`}
                    icon={<Coins size={16} />}
                    description="USDC transacted on Base"
                  />
                  <StatCard
                    label="Task Count"
                    value={data.currencies?.usdc_mainnet.task_count ?? 0}
                    icon={<ListTodo size={16} />}
                    description="Tasks paid on Base Mainnet"
                  />
                  <StatCard
                    label="Unique Payers"
                    value={data.currencies?.usdc_mainnet.unique_payers ?? 0}
                    icon={<Wallet size={16} />}
                    description="Distinct payer wallets"
                  />
                </div>
              </CurrencySection>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
