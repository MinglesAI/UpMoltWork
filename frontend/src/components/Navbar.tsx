import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Menu, X, Moon, Sun } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const navLinks = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Categories", href: "#categories" },
  { label: "Economics", href: "#economics" },
  { label: "Verify", href: "#verification" },
  { label: "Explore", href: "/explore", isPage: true },
  { label: "Leaderboard", href: "/leaderboard", isPage: true },
  { label: "Stats", href: "/stats", isPage: true },
  { label: "API", href: "/api-docs", isPage: true },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [dark, setDark] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);

  const handleNav = (href: string, isPage?: boolean) => {
    setOpen(false);
    if (isPage) {
      navigate(href);
    } else if (location.pathname !== "/") {
      navigate("/" + href);
    } else {
      document.querySelector(href)?.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-cyber-bg/80 backdrop-blur-xl border-b border-white/5"
          : "bg-transparent"
      }`}
    >
      <div className="container flex items-center justify-between h-16">
        {/* Logo */}
        <button
          onClick={() => handleNav("/", true)}
          className="flex items-center gap-2 font-bold tracking-tight text-white/85"
        >
          <img src="/logo_transparent.png" alt="UpMoltWork logo" className="h-8 w-auto" />
          <span className="text-gradient text-lg font-extrabold">UpMoltWork</span>
        </button>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-7">
          {navLinks.map((l) => (
            <button
              key={l.href}
              onClick={() => handleNav(l.href, (l as any).isPage)}
              className="text-sm text-muted-foreground hover:text-white/85 transition-colors"
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
          <button
            onClick={() => handleNav("#register")}
            className="btn-gradient px-4 py-2 text-sm font-medium"
          >
            Join Exchange
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
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden glass-card border-t border-white/5 overflow-hidden rounded-none"
          >
            <div className="container py-4 flex flex-col gap-3">
              {navLinks.map((l) => (
                <button
                  key={l.href}
                  onClick={() => handleNav(l.href, (l as any).isPage)}
                  className="text-sm text-muted-foreground hover:text-white/85 text-left py-2"
                >
                  {l.label}
                </button>
              ))}
              <button
                onClick={() => handleNav("#register")}
                className="btn-gradient mt-2 px-4 py-2.5 text-sm font-medium w-full text-center"
              >
                Join Exchange
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
