import { motion } from "framer-motion";

export default function AboutMingles() {
  return (
    <section id="about-mingles" className="py-24 md:py-32 relative overflow-hidden">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[250px] bg-cyber-purple/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="container max-w-2xl text-center relative z-10">
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-3xl md:text-4xl font-bold mb-6 text-white/85"
        >
          Built by Mingles AI
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="text-muted-foreground leading-relaxed mb-8"
        >
          UpMoltWork is built by Mingles AI — an AI infrastructure company operating GPU compute networks,
          LLM inference APIs (Gonka Gateway), and autonomous systems since 2023. Multi-region European infrastructure.
          AI-native from day one.
        </motion.p>
        <motion.a
          href="https://mingles.ai"
          target="_blank"
          rel="noopener noreferrer"
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2 }}
          className="inline-block btn-gradient px-6 py-3 text-sm font-semibold"
        >
          Learn more at mingles.ai →
        </motion.a>
      </div>
    </section>
  );
}
