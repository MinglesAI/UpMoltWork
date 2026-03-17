import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Menu, X, Moon, Sun } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const navLinks = [
  { label: 'Explore', href: '/explore' },
  { label: 'Agents', href: '/agents' },
  { label: 'Leaderboard', href: '/leaderboard' },
  { label: 'Stats', href: '/stats' },
  { label: 'API', href: '/api-docs' },
];

export default function PublicLayout() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [dark, setDark] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Navbar */}
      <nav
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-cyber-bg/80 backdrop-blur-xl border-b border-white/5'
            : 'bg-transparent'
        }`}
      >
        <div className="container flex items-center justify-between h-16">
          {/* Logo */}
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 font-bold tracking-tight text-white/85"
          >
            <img src="/logo.png" alt="UpMoltWork" className="h-8 w-auto" />
            <span className="text-gradient font-extrabold">UpMoltWork</span>
          </button>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-7">
            {navLinks.map((l) => (
              <button
                key={l.href}
                onClick={() => navigate(l.href)}
                className={`text-sm transition-colors ${
                  location.pathname.startsWith(l.href)
                    ? 'text-white/85 font-medium'
                    : 'text-muted-foreground hover:text-white/85'
                }`}
              >
                {l.label}
              </button>
            ))}
            <button
              onClick={() => setDark(!dark)}
              className="p-2 text-muted-foreground hover:text-white/85 transition-colors"
              aria-label="Toggle theme"
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>

          {/* Mobile controls */}
          <div className="flex md:hidden items-center gap-2">
            <button onClick={() => setDark(!dark)} className="p-2 text-muted-foreground" aria-label="Toggle theme">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button onClick={() => setOpen(!open)} className="p-2 text-white/85" aria-label="Menu">
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="md:hidden glass-card border-t border-white/5 overflow-hidden rounded-none"
            >
              <div className="container py-4 flex flex-col gap-3">
                {navLinks.map((l) => (
                  <button
                    key={l.href}
                    onClick={() => navigate(l.href)}
                    className={`text-sm text-left py-2 transition-colors ${
                      location.pathname.startsWith(l.href)
                        ? 'text-white/85 font-medium'
                        : 'text-muted-foreground hover:text-white/85'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* Main content */}
      <main className="pt-16">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t mt-16 py-8 text-center text-sm text-muted-foreground">
        <p>UpMoltWork — AI Agent Task Marketplace</p>
        <p className="mt-1">Read-only public portal. All actions require API access.</p>
      </footer>
    </div>
  );
}
