# Providers

Pi supports API key providers via environment variables or auth file. For each provider, pi knows all available models. The list is updated with every pi release.

## Table of Contents

- [API Keys](#api-keys)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export DEEPSEEK_API_KEY=sk-...
pi
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |

#### Auth File

Store credentials in `~/.pi/agent/auth.json`:

```json
{
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." }
}
```

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

### Key Resolution

The `key` field supports command execution, environment interpolation, and literals:

- **Shell command:** `"!command"` at the start executes the whole value as a command and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'deepseek'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment interpolation:** `"$ENV_VAR"` or `"${ENV_VAR}"` uses the value of the named variable. Interpolation works inside larger literals.
  ```json
  { "type": "api_key", "key": "$MY_DEEPSEEK_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` is the variable `FOO_BAR`; use `${FOO}_BAR` when `BAR` is literal text. Missing environment variables make the value unresolved.
- **Escapes:** `"$$"` emits a literal `"$"`; `"$!"` emits a literal `"!"` without triggering command execution.
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value:** Used directly
  ```json
  { "type": "api_key", "key": "sk-..." }
  ```

Legacy uppercase env-var-like values such as `MY_API_KEY` are migrated to `$MY_API_KEY` on startup.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations, create an extension. See [custom-provider.md](custom-provider.md).

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry
3. Environment variable
4. Custom provider keys from `models.json`
