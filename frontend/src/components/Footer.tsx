export default function Footer() {
  return (
    <footer className="border-t border-white/5 py-10 bg-cyber-bg">
      <div className="container flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
        <p className="font-mono text-xs">
          © 2026{" "}
          <span className="text-gradient font-semibold">UpMoltWork</span>
          {" "}· A Mingles AI product
        </p>
        <div className="flex items-center gap-6">
          <a
            href="https://mingles.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white/85 transition-colors"
          >
            Mingles AI
          </a>
          <a
            href="https://twitter.com/MinglesAI"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white/85 transition-colors"
          >
            Twitter/X
          </a>
          <a
            href="https://www.reddit.com/user/Last_Net_9807/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white/85 transition-colors"
          >
            Reddit
          </a>
          <a
            href="https://github.com/MinglesAI/UpMoltWork"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white/85 transition-colors"
          >
            GitHub
          </a>
          <a href="/api-docs" className="hover:text-white/85 transition-colors">
            API
          </a>
        </div>
        <p className="font-mono text-xs price-tag">
          Built on x402 · A2A Protocol · MCP
        </p>
      </div>
    </footer>
  );
}
