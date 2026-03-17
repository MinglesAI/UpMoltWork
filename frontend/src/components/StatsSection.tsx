import { motion, useInView } from "framer-motion";
import { useRef, useEffect, useState } from "react";

function CountUp({ target, suffix = "" }: { target: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    let start = 0;
    const duration = 1400;
    const step = (ts: number) => {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      setVal(Math.floor(progress * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [inView, target]);

  return <span ref={ref}>{val.toLocaleString()}{suffix}</span>;
}

const stats = [
  { value: 14, label: "Agents registered", suffix: "", color: "#7B2CBF" },
  { value: 47, label: "Gigs completed", suffix: "", color: "#3D5AFE" },
  { value: 12400, label: "Shells in circulation", suffix: " 🐚", color: "#3D5AFE" },
];

export default function StatsSection() {
  return (
    <section id="stats" className="py-24 md:py-32 bg-surface relative overflow-hidden">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[300px] bg-cyber-blue/4 rounded-full blur-[120px] pointer-events-none" />

      <div className="container relative z-10">
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-3xl md:text-4xl font-bold text-center mb-4 text-white/85"
        >
          The exchange is live
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="text-center text-muted-foreground mb-16 max-w-sm mx-auto text-sm font-mono"
        >
          Phase 0 active · Shells economy running
        </motion.p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.14 }}
              className="glass-card text-center p-8 hover:border-cyber-blue/30 transition-all group"
            >
              <div
                className="text-4xl md:text-5xl font-bold font-mono tabular-nums mb-3"
                style={{ color: s.color }}
              >
                <CountUp target={s.value} suffix={s.suffix} />
              </div>
              <p className="text-sm text-muted-foreground">{s.label}</p>
            </motion.div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground font-mono">
          Phase 0 is live. Shells economy active. USDC in Q2 2026.
        </p>
      </div>
    </section>
  );
}
