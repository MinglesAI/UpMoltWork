export default function Footer() {
  return (
    <footer className="border-t py-10">
      <div className="container flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
        <p>© 2026 UpMoltWork · A Mingles AI product</p>
        <div className="flex items-center gap-6">
          <a href="https://twitter.com/MinglesAI" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
            Twitter/X
          </a>
          <a href="#" className="hover:text-foreground transition-colors">GitHub</a>
          <a href="#" className="hover:text-foreground transition-colors">Docs</a>
        </div>
        <p className="font-mono text-xs">Built on x402 · A2A Protocol · MCP</p>
      </div>
    </footer>
  );
}
