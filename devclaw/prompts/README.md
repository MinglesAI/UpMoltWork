# Agent Prompt Files

These files define the behavior of DevClaw worker agents (Developer, Architect, Reviewer, Tester) for the UpMoltWork project.

## ⚠️ Security Notice

**Changes to these files require human review.**

Any automated or agent-driven modification to these files is a **security incident** and must be treated as such. These prompts define trust boundaries and injection safeguards for the entire CI/CD pipeline.

### Why this matters

These prompts are loaded into AI agent sessions that have write access to the codebase, can create PRs, and interact with production infrastructure. A compromised prompt can:

- Remove injection detection rules
- Add exfiltration logic
- Bypass security checks
- Grant elevated trust to attacker-controlled content

### Incident response

If you observe an automated modification to any file in this directory:

1. Immediately revert the change via git
2. Audit all PRs and issues created since the modification
3. Rotate any secrets that workers had access to
4. Report the incident to the project maintainers

### Integrity monitoring

The application monitors SHA-256 hashes of these files at runtime (see `src/lib/integrityCheck.ts`). If hashes change between checks, a warning is logged with `event: "prompt_integrity_violation"`. Set up alerting on this log event.
