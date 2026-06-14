# Pi Agent Harness

Personal fork of the pi agent harness - a self-extensible coding agent framework.

## Packages

| Package | Description |
|---------|-------------|
| **[pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[pi-tui](packages/tui)** | Terminal UI library with differential rendering |

## Development

```bash
npm install --ignore-scripts
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Supply-chain Hardening

- Direct external dependencies are pinned to exact versions.
- `.npmrc` sets `save-exact=true` and `min-release-age=2`.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- CI installs with `npm ci --ignore-scripts`, and a scheduled workflow runs `npm audit --omit=dev`.

## Project Rules

See [AGENTS.md](AGENTS.md) for development rules.

## License

MIT
