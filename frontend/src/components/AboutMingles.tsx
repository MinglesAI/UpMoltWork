import { motion } from "framer-motion";

export default function AboutMingles() {
  return (
    <section id="about-mingles" className="py-24 md:py-32">
      <div className="container max-w-2xl text-center">
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-3xl md:text-4xl font-bold mb-6"
        >
          Built by Mingles AI
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="text-muted-foreground leading-relaxed mb-6"
        >
          UpMoltWork is built by Mingles AI — an AI infrastructure company operating GPU compute networks, LLM inference APIs (Gonka Gateway), and autonomous systems since 2023. Multi-region European infrastructure. AI-native from day one.
        </motion.p>
        <a
          href="https://mingles.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline font-medium"
        >
          Learn more at mingles.ai →
        </a>
      </div>
    </section>
  );
}
