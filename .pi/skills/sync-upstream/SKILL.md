---
name: sync-upstream
description: Review and selectively merge commits from the upstream repository (earendil-works/pi) into this fork. Use when the user wants to sync, update from upstream, check for new upstream changes, or cherry-pick upstream commits.
disable-model-invocation: true

---

# Sync Upstream

This skill helps review and merge commits from the upstream repository into this personal fork.

## Fork Context

This is a personal fork for local development. The following upstream content was intentionally removed or modified. **You must understand this context before recommending any upstream commits.**

### Removed Files (will conflict if upstream modifies them)

- `CONTRIBUTING.md` — not needed for personal development
- `SECURITY.md` — referenced earendil.com and pi.dev
- `.pi/extensions/redraws.ts` — upstream dev extensions
- `packages/coding-agent/src/modes/interactive/components/earendil-announcement.ts` — upstream brand component
- `packages/coding-agent/src/modes/interactive/assets/clankolas.png` — component image asset

### Modified Source Files (will conflict if upstream modifies them)

- `packages/coding-agent/src/utils/version-check.ts` — pi.dev version check disabled (URL set to empty string)
- `packages/coding-agent/src/config.ts` — self-update URL changed to `A1exthegreat/pi`, share viewer URL disabled
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — install telemetry removed (method is now no-op), EarendilAnnouncementComponent import and `/dementedelves` command removed, changelog URL changed to GitHub
- `packages/coding-agent/src/core/provider-attribution.ts` — OpenRouter `HTTP-Referer: https://pi.dev` header removed
- `packages/coding-agent/src/migrations.ts` — GitHub URLs updated to `A1exthegreat/pi`
- `packages/coding-agent/src/cli/args.ts` — `PI_SHARE_VIEWER_URL` help text updated
- Theme JSON files (`dark.json`, `light.json`, `dynamic.json`) — `$schema` URLs updated to `A1exthegreat/pi`

### Modified Test Files

- `test/version-check.test.ts` — tests updated for disabled version check
- `test/sdk-openrouter-attribution.test.ts` — `HTTP-Referer` assertions changed to `toBeUndefined()`
- `test/pi-user-agent.test.ts` — description text updated

### Modified Documentation (will conflict if upstream modifies them)

- `README.md` — completely rewritten (simplified personal project README)
- `packages/coding-agent/README.md` — upstream branding, Discord, npm badges, session sharing removed
- `AGENTS.md` — GitHub URLs updated to `A1exthegreat/pi`
- Multiple files in `packages/coding-agent/docs/` — upstream URLs and references updated

### OAuth Login Removed (API-key-only auth)

OAuth authentication flows have been completely removed. All providers now use API-key-only authentication.

- `auth-storage.ts` — `AuthCredential` type is only `ApiKeyCredential`, no OAuth credential type
- `interactive-mode.ts` — `isApiKeyLoginProvider()` always returns `true`; `/login` command goes directly to `showApiKeyLoginDialog()`; no actual OAuth flow exists
- `login-dialog.ts` — sole login path, prompts for API key string only
- `oauth-selector.ts` — component still exists and is used as a generic provider selector, but `authType: "oauth"` variant is never used in practice
- `auth-guidance.ts` — still has stale OAuth help text (known remnant)
- `args.ts` — still lists `ANTHROPIC_OAUTH_TOKEN` in help text (known remnant)
- `migrations.ts` — `migrateAuthToAuthJson()` migrates legacy `oauth.json` to `auth.json` (known remnant)

**Impact on upstream sync**: Any upstream commit that adds, modifies, or refactors OAuth login flows, OAuth token refresh, OAuth credential types, or `/login` UI should be **skipped**. The `packages/ai/` package has no OAuth code at all.

### Model Providers Reduced (opencode relay only)

Direct provider access has been removed. All models now route through the `opencode` or `opencode-go` relay services, or directly to DeepSeek's API.

- `packages/ai/src/types.ts` — `KnownProvider` is only `"deepseek" | "opencode" | "opencode-go"`
- `packages/ai/src/env-api-keys.ts` — `ENV_MAP` only maps: `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`
- `packages/ai/src/models.generated.ts` — only 3 provider sections (deepseek, opencode, opencode-go)
- `packages/ai/scripts/generate-models.ts` — only fetches from opencode/deepseek, no Anthropic/OpenAI/Google direct
- `packages/coding-agent/src/core/model-resolver.ts` — `defaultModelPerProvider` maps only the 3 kept providers
- `packages/coding-agent/src/core/provider-display-names.ts` — only the 3 kept providers

The underlying API protocol implementations (`anthropic.ts`, `openai-completions.ts`, `openai-responses.ts`, `google.ts`) are kept because the opencode relay speaks those protocols. The `register-builtins.ts` registers exactly 4 API types.

**Impact on upstream sync**: Any upstream commit that adds a new direct provider (e.g., `mistral.ts`, `bedrock.ts`), adds new `KnownProvider` values, adds new `ENV_MAP` entries, or modifies `generate-models.ts` to fetch from new sources should be **skipped**. Changes to the 4 existing API protocol implementations (anthropic, openai-completions, openai-responses, google) are safe to pick if they fix bugs.

### Visual Assist Model Routing (fork-specific feature)

This fork adds a vision preprocessing system that routes image understanding to a separate, user-configured vision model when the main model does not support images natively.

**New files added by this fork:**

- `packages/coding-agent/src/core/vision-preprocessor.ts` — main logic: `preprocessVision()` checks if main model supports images; if not, sends images to a configured vision model via `completeSimple()` and replaces image blocks with text descriptions

**Modified files for vision routing:**

- `packages/coding-agent/src/core/settings-manager.ts` — added `VisionModelSettings` interface (`{ provider, modelId }`), getter/setter `getVisionModel()`/`setVisionModel()`
- `packages/coding-agent/src/core/sdk.ts` — `preprocessVision()` called before every model request in the `streamFn` wrapper
- `packages/coding-agent/src/core/agent-session.ts` — vision diagnostic type `{ type: "vision_model_call" }` and pending diagnostic emission
- `packages/coding-agent/src/core/tools/read.ts` — `getNonVisionImageNote()` returns placeholder text when model doesn't support images

**Impact on upstream sync**: Any upstream commit that modifies `sdk.ts` stream wrapper, `settings-manager.ts` settings schema, or `agent-session.ts` diagnostic types may conflict with vision routing code. Review these carefully and preserve the vision preprocessing integration.

### What Was NOT Changed (intentionally preserved)

- npm scope `@earendil-works/*` — kept as-is across all packages
- `Symbol.for("@earendil-works/pi-coding-agent:theme")` — kept
- `@mariozechner/*` backward-compat aliases in extension loader — kept
- CLI binary name `pi`, config dir `.pi`, env var prefix `PI_` — kept
- CHANGELOG.md files — historical records preserved as-is (including old repo URLs)

## Commit Classification Rules

When reviewing upstream commits, use these rules:

| Category                                           | Action             | Reason                                                       |
| -------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| Bug fix in source code                             | **Recommend pick** | Generally safe and useful                                    |
| Bug fix in tests                                   | **Recommend pick** | Keep test coverage current                                   |
| Bug fix in API protocols (anthropic/openai/google) | **Recommend pick** | Relay depends on these; fixes are safe                       |
| New feature                                        | **Ask user**       | User decides based on their needs                            |
| pi.dev URL changes                                 | **Skip**           | This fork has disabled all pi.dev endpoints                  |
| Earendil/branding changes                          | **Skip**           | This fork has removed all upstream branding                  |
| Discord/community changes                          | **Skip**           | Not relevant for personal fork                               |
| Session sharing features                           | **Skip**           | Disabled in this fork                                        |
| Telemetry changes                                  | **Skip**           | Disabled in this fork                                        |
| OAuth login/token/credential changes               | **Skip**           | OAuth removed; this fork uses API-key-only auth              |
| `/login` UI changes                                | **Skip**           | Login flow completely restructured for API-key-only          |
| New direct provider (e.g. bedrock, mistral)        | **Skip**           | Only opencode relay + deepseek kept                          |
| `KnownProvider`/`ENV_MAP` additions                | **Skip**           | Provider list intentionally reduced                          |
| `generate-models.ts` new source additions          | **Skip**           | Model generation scoped to opencode/deepseek only            |
| CONTRIBUTING/SECURITY/docs                         | **Skip**           | These files were deleted in this fork                        |
| Dependency updates                                 | **Caution**        | Check lockfile impact; run `npm install --ignore-scripts` after |
| Model registry updates (`models.generated.ts`)     | **Caution**        | Only safe if changes are within opencode/deepseek sections   |
| Refactoring                                        | **Recommend pick** | Safe unless it touches the modified files listed above       |
| Release commits                                    | **Skip**           | Version bumps and changelog entries are fork-specific        |
| CI/workflow changes                                | **Ask user**       | Workflows were kept but may need updating                    |
| Vision/image handling changes                      | **Caution**        | Fork has custom vision preprocessor; preserve `vision-preprocessor.ts` integration |
| `sdk.ts` stream wrapper changes                    | **Caution**        | Fork calls `preprocessVision()` in stream wrapper; preserve integration |
| `settings-manager.ts` schema changes               | **Caution**        | Fork adds `VisionModelSettings`; preserve vision settings    |

### Conflict Resolution Strategy

When a cherry-pick conflicts with fork changes:

1. **If the upstream change is in a deleted file** (CONTRIBUTING.md, SECURITY.md, etc.): skip the commit entirely.
2. **If the upstream change mixes functional code with branding** (e.g., adding a feature near a telemetry call): manually extract only the functional part, discard the branding/telemetry changes.
3. **If the upstream change is purely in a modified file** (e.g., `config.ts` URL changes): skip if it's URL/branding related; carefully merge if it's functional.
4. **If the upstream change adds OAuth/provider logic** to a file that also has functional changes (e.g., `auth-storage.ts` gains a new field alongside OAuth types): extract only the non-OAuth functional changes and discard the OAuth parts.
5. **If the upstream change modifies `sdk.ts`, `settings-manager.ts`, or `agent-session.ts`**: carefully merge to preserve the fork's vision preprocessing integration. The `preprocessVision()` call in the stream wrapper and `VisionModelSettings` in settings must not be lost.
6. **When in doubt**: ask the user before proceeding.

## Workflow

### Step 1: Check status

```bash
node scripts/sync-upstream.mjs status
```

If the count is 0, tell the user the fork is already up to date and stop.

### Step 2: Review new commits

```bash
node scripts/sync-upstream.mjs log
```

Filter by package if needed:

```bash
node scripts/sync-upstream.mjs log packages/ai/
node scripts/sync-upstream.mjs log packages/coding-agent/
node scripts/sync-upstream.mjs log packages/tui/
node scripts/sync-upstream.mjs log packages/agent/
```

### Step 3: Assess conflict risk

```bash
node scripts/sync-upstream.mjs conflicts
```

Cross-reference the conflicting files list with the "Modified Source Files" section above. Files in both lists are high-risk.

### Step 4: Classify and recommend

For each upstream commit, apply the classification rules from the table above. Present a grouped summary to the user:

```
Recommended to pick (N commits):
  - abc1234 fix(ai): handle edge case in streaming
  - def5678 fix(tui): fix CJK text wrapping

Ask for your decision (N commits):
  - ghi9012 feat(coding-agent): add new export format
  - jkl3456 feat(agent): add new hook event

Recommended to skip (N commits):
  - mno7890 chore: Release v0.80.0 (release commit)
  - pqr1234 docs: update pi.dev links (branding change)
```

Let the user confirm before proceeding.

### Step 5: Cherry-pick selected commits

```bash
node scripts/sync-upstream.mjs pick <sha1> <sha2> <sha3>
```

Or a range:

```bash
node scripts/sync-upstream.mjs pick-range <start-sha> <end-sha>
```

For specific files only:

```bash
node scripts/sync-upstream.mjs grab <path1> <path2>
```

### Step 6: Verify

```bash
npm run check
```

Fix any errors. If `npm run check` fails on test assertions, update the tests to match the new upstream behavior while preserving the fork's customizations.

### Step 7: Commit

Review staged changes if any commits were applied with conflict warnings:

```bash
git diff --cached --stat
```

Commit when satisfied. Do NOT push unless the user explicitly asks.

## Important Notes

- The npm scope `@earendil-works/*` is intentionally kept. Do not rename it.
- After dependency updates from upstream, run `npm install --ignore-scripts` to update the lockfile.
- Never force-push or rebase published commits.
- When resolving conflicts, always prefer keeping the fork's changes over upstream's branding/URL/telemetry changes.
- If a large upstream refactor touches many of the fork's modified files, consider using `grab` to selectively pull only the files you need rather than cherry-picking the entire commit.