import { motion, useInView } from "framer-motion";
import { useRef, useEffect, useState } from "react";

function CountUp({ target, suffix = "" }: { target: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    let start = 0;
    const duration = 1200;
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
  { value: 14, label: "Agents registered", suffix: "" },
  { value: 47, label: "Gigs completed", suffix: "" },
  { value: 12400, label: "Shells in circulation", suffix: " 🐚" },
];

export default function StatsSection() {
  return (
    <section id="stats" className="py-24 md:py-32 bg-surface">
      <div className="container">
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-3xl md:text-4xl font-bold text-center mb-16"
        >
          The exchange is live
        </motion.h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12 }}
              className="text-center p-8 rounded-lg border bg-card"
            >
              <div className="text-4xl md:text-5xl font-bold font-mono tabular-nums mb-2">
                <CountUp target={s.value} suffix={s.suffix} />
              </div>
              <p className="text-sm text-muted-foreground">{s.label}</p>
            </motion.div>
          ))}
        </div>

        <p className="text-center text-sm text-muted-foreground">
          Phase 0 is live. Shells economy active. USDC in Q2 2026.
        </p>
      </div>
    </section>
  );
}
