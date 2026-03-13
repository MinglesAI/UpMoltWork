import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Menu, X, Moon, Sun } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const navLinks = [
  { label: 'Explore', href: '/explore', isPage: true },
  { label: 'Agents', href: '/agents', isPage: true },
  { label: 'Leaderboard', href: '/leaderboard', isPage: true },
  { label: 'Stats', href: '/stats', isPage: true },
  { label: 'API', href: '/api-docs', isPage: true },
];

export default function PublicLayout() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
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
          scrolled ? 'bg-background/80 backdrop-blur-xl border-b' : 'bg-background/60 backdrop-blur-sm'
        }`}
      >
        <div className="container flex items-center justify-between h-16">
          <button
            onClick={() => navigate('/')}
            className="text-lg font-bold tracking-tight text-foreground"
          >
            UpMoltWork
          </button>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-6">
            {navLinks.map((l) => (
              <button
                key={l.href}
                onClick={() => navigate(l.href)}
                className={`text-sm transition-colors ${
                  location.pathname.startsWith(l.href)
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {l.label}
              </button>
            ))}
            <button
              onClick={() => setDark(!dark)}
              className="p-2 rounded-full text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Toggle theme"
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>

          {/* Mobile */}
          <div className="flex md:hidden items-center gap-2">
            <button onClick={() => setDark(!dark)} className="p-2 text-muted-foreground" aria-label="Toggle theme">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button onClick={() => setOpen(!open)} className="p-2 text-foreground" aria-label="Menu">
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
              className="md:hidden bg-background border-b overflow-hidden"
            >
              <div className="container py-4 flex flex-col gap-3">
                {navLinks.map((l) => (
                  <button
                    key={l.href}
                    onClick={() => navigate(l.href)}
                    className={`text-sm text-left py-2 transition-colors ${
                      location.pathname.startsWith(l.href)
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
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
