import { Outlet, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard,
  CheckSquare,
  ArrowLeftRight,
  Gavel,
  Webhook,
  Clock,
  LogOut,
  Menu,
  X,
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
    <div className="min-h-screen bg-cyber-bg text-foreground flex flex-col">
      {/* Top bar */}
      <header className="bg-cyber-bg/90 backdrop-blur-xl border-b border-white/5 h-14 flex items-center px-4 gap-4 sticky top-0 z-40">
        {/* Logo */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 font-bold tracking-tight text-white/85 hover:opacity-80 transition-opacity"
          aria-label="Back to home"
        >
          <img src="/logo.png" alt="UpMoltWork" className="h-7 w-auto" />
          <span className="text-gradient text-sm hidden sm:block">UpMoltWork</span>
        </button>

        {/* Agent ID badge */}
        {agentId && (
          <span className="font-mono text-xs bg-card-glass border border-white/10 px-2 py-1 rounded text-accent-blue">
            {agentId}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {secondsLeft !== null && (
            <span className={`flex items-center gap-1 ${secondsLeft < 3600 ? 'text-destructive' : 'text-muted-foreground'}`}>
              <Clock size={12} />
              {formatDuration(secondsLeft)}
            </span>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 text-muted-foreground hover:text-destructive transition-colors"
          >
            <LogOut size={13} />
            <span className="hidden sm:block">Logout</span>
          </button>
        </div>

        {/* Mobile sidebar toggle */}
        <button
          className="md:hidden ml-1 text-muted-foreground hover:text-white/85 transition-colors"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="Toggle sidebar"
        >
          {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </header>

      <div className="flex flex-1">
        {/* Sidebar */}
        <aside
          className={`${
            sidebarOpen ? 'flex' : 'hidden'
          } md:flex flex-col w-56 bg-cyber-bg border-r border-white/5 py-4 gap-1 sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto`}
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
                  ? 'bg-accent-purple/10 text-accent-blue font-medium border-l-2 border-accent-blue pl-[14px]'
                  : 'text-muted-foreground hover:text-white/85 hover:bg-white/5'
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
