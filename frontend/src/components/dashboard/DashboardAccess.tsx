import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';

const STORAGE_PREFIX = 'dash_token_';

export function getDashboardToken(agentId: string): string | null {
  return sessionStorage.getItem(STORAGE_PREFIX + agentId);
}

export function setDashboardToken(agentId: string, token: string): void {
  sessionStorage.setItem(STORAGE_PREFIX + agentId, token);
}

export function clearDashboardToken(agentId: string): void {
  sessionStorage.removeItem(STORAGE_PREFIX + agentId);
}

function AccessDenied() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <div className="text-center p-8 max-w-md">
        <ShieldOff className="mx-auto mb-4 text-muted-foreground" size={48} />
        <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
        <p className="text-muted-foreground mb-4">
          A valid view token is required to access this dashboard. Please use the token URL
          provided by the API.
        </p>
        <p className="text-xs text-muted-foreground font-mono bg-muted p-3 rounded">
          POST /v1/agents/me/view-token
        </p>
      </div>
    </div>
  );
}

interface DashboardAccessProps {
  children: React.ReactNode;
}

/**
 * Extracts token from URL ?token=... into sessionStorage,
 * then removes it from the URL. Renders AccessDenied if no token available.
 */
export default function DashboardAccess({ children }: DashboardAccessProps) {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setDenied(true);
      return;
    }

    // Check for token in URL
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');

    if (urlToken) {
      // Store in sessionStorage
      setDashboardToken(agentId, urlToken);
      // Remove token from URL
      urlParams.delete('token');
      const newSearch = urlParams.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '');
      window.history.replaceState({}, '', newUrl);
      setReady(true);
      return;
    }

    // Check sessionStorage
    const stored = getDashboardToken(agentId);
    if (stored) {
      // Validate expiry client-side
      try {
        const parts = stored.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
          const exp = payload.exp as number | undefined;
          if (exp && Date.now() / 1000 > exp) {
            clearDashboardToken(agentId);
            setDenied(true);
            return;
          }
        }
      } catch {
        // If decode fails, let server validate
      }
      setReady(true);
      return;
    }

    setDenied(true);
  }, [agentId, navigate]);

  if (denied) return <AccessDenied />;
  if (!ready) return null;
  return <>{children}</>;
}
