import { Outlet, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard,
  CheckSquare,
  ArrowLeftRight,
  Gavel,
  Webhook,
  ChevronLeft,
  Clock,
} from 'lucide-react';
import { getDashboardToken, clearDashboardToken } from '../components/dashboard/DashboardAccess';

const sidebarItems = [
  { label: 'Overview', path: '', icon: LayoutDashboard },
  { label: 'Tasks', path: '/tasks', icon: CheckSquare },
  { label: 'Transactions', path: '/txs', icon: ArrowLeftRight },
  { label: 'Bids', path: '/bids', icon: Gavel },
  { label: 'Webhooks', path: '/hooks', icon: Webhook },
];

function useTokenExpiry(agentId: string | undefined) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!agentId) return;
    const token = getDashboardToken(agentId);
    if (!token) return;

    // Decode JWT payload (no verify, just decode)
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return;
      const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
      const exp = payload.exp as number | undefined;
      if (!exp) return;

      const update = () => {
        const diff = Math.max(0, exp - Math.floor(Date.now() / 1000));
        setSecondsLeft(diff);
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    } catch {
      // ignore
    }
  }, [agentId]);

  return secondsLeft;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

export default function DashboardLayout() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const secondsLeft = useTokenExpiry(agentId);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const basePath = `/dashboard/${agentId}`;

  const isActive = useCallback(
    (path: string) => {
      const full = basePath + path;
      if (path === '') return location.pathname === basePath || location.pathname === basePath + '/';
      return location.pathname.startsWith(full);
    },
    [basePath, location.pathname],
  );

  const handleLogout = () => {
    if (agentId) clearDashboardToken(agentId);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top bar */}
      <header className="border-b h-14 flex items-center px-4 gap-4 sticky top-0 z-40 bg-background">
        <button
          onClick={() => navigate('/')}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to home"
        >
          <ChevronLeft size={20} />
        </button>
        <span className="font-semibold text-sm">Dashboard</span>
        {agentId && (
          <span className="text-xs text-muted-foreground font-mono bg-muted px-2 py-1 rounded">
            {agentId}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {secondsLeft !== null && (
            <span className={`flex items-center gap-1 ${secondsLeft < 3600 ? 'text-destructive' : ''}`}>
              <Clock size={12} />
              {formatDuration(secondsLeft)}
            </span>
          )}
          <button
            onClick={handleLogout}
            className="text-muted-foreground hover:text-destructive transition-colors"
          >
            Logout
          </button>
        </div>
        {/* Mobile sidebar toggle */}
        <button
          className="md:hidden ml-2 text-muted-foreground hover:text-foreground"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <LayoutDashboard size={18} />
        </button>
      </header>

      <div className="flex flex-1">
        {/* Sidebar */}
        <aside
          className={`${
            sidebarOpen ? 'flex' : 'hidden'
          } md:flex flex-col w-56 border-r py-4 gap-1 sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto`}
        >
          {sidebarItems.map(({ label, path, icon: Icon }) => (
            <button
              key={path}
              onClick={() => {
                navigate(basePath + path);
                setSidebarOpen(false);
              }}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors mx-2 rounded-md ${
                isActive(path)
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </aside>

        {/* Content */}
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
