# 开发规则

## 对话风格

- 回答保持简短精炼
- 提交信息、议题、PR 评论和代码中不使用表情符号
- 不要有冗余或过于热情的文字（例如，用"Thanks @user"而非"Thanks so much @user!"）
- 只使用技术性语言，直接表达
- 用户提问时，先回答问题，然后再进行编辑或执行命令
- 回复用户的反馈或分析时，先明确表示同意或不同意，再说明做了什么改动
- 使用中文进行回复

## 代码质量

- 在进行大范围更改、编辑未完全检查的文件，或被要求调查/审计时，先完整阅读文件。不要依赖搜索片段进行大范围修改
- 除非绝对必要，否则不使用 `any`
- 只有一个调用点的单行辅助函数应内联
- 检查 node_modules 中的外部 API 类型，不要猜测
- **不要使用内联导入**（`await import()`、`import("pkg").Type`、动态类型导入）。只使用顶层导入
- 永远不要为了修复过时的依赖导致的类型错误而移除或降级代码；应升级依赖
- 在根配置检查的代码中（`packages/*/src`、`packages/*/test`、`packages/coding-agent/examples`），只使用可擦除的 TypeScript 语法（Node strip-only 模式）：不使用参数属性、`enum`、`namespace`/`module`、`import =`、`export =` 或其他需要 JS 产出的结构。使用显式字段配合构造函数赋值
- 在移除看似有意为之的功能或代码前，先征询意见
- 除非用户要求，否则不保持向后兼容
- 永远不要硬编码按键检查（例如 `matchesKey(keyData, "ctrl+x")`）。向 `TUI_KEYBINDINGS` 或 `KEYBINDINGS` 添加默认值，使其保持可配置
- 永远不要直接修改 `packages/ai/src/models.generated.ts`；应更新 `packages/ai/scripts/generate-models.ts` 然后重新生成。包含生成的 `models.generated.ts` 的 diff 总是可以的，即使重新生成包含了无关的上游模型元数据变更

## 命令

- 代码更改后（非文档）：运行 `npm run check`（完整输出，不截断）。在提交前修复所有错误、警告和信息。不运行测试
- 除非用户要求，否则永远不要运行 `npm run build` 或 `npm test`
- 永远不要直接运行完整的 vitest 套件：它包含在设置了 endpoint/auth 环境变量时才会激活的 e2e 测试。对于所有非 e2e 测试，从仓库根目录运行 `./test.sh`。否则从包根目录运行特定测试：`node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- 如果创建或修改了测试文件，运行它并迭代测试或实现直到通过
- 对于 `packages/coding-agent/test/suite/`，使用 `test/suite/harness.ts` + faux 提供程序。不使用真实的提供程序 API、密钥或付费 token
- 将议题特定的回归测试放在 `packages/coding-agent/test/suite/regressions/` 下，命名为 `<issue-number>-<short-slug>.test.ts`
- 对于临时脚本，将其写入临时文件（例如 `/tmp`），运行，按需编辑，完成后删除。不要在 `bash` 命令中嵌入多行脚本
- 除非用户要求，否则永不提交

## 依赖与安装安全

- 将 npm 依赖和 lockfile 变更视为需审查的代码。直接外部依赖固定到精确版本
- 本地安装/更新使用 `npm install --ignore-scripts`；干净/CI 风格使用 `npm ci --ignore-scripts`。除非用户要求，否则不运行生命周期脚本
- 如果依赖元数据发生变化，使用 `npm install --package-lock-only --ignore-scripts` 刷新 `package-lock.json`
- 如果 `packages/coding-agent/npm-shrinkwrap.json` 需要重新生成，运行 `node scripts/generate-coding-agent-shrinkwrap.mjs`（使用 `--check` 或 `npm run check` 验证）。带有生命周期脚本的新依赖需要审查并在该脚本中显式添加白名单条目；永远不要静默添加
- 预提交钩子阻止 lockfile 提交，除非设置了 `PI_ALLOW_LOCKFILE_CHANGE=1`。除非用户希望提交 lockfile 变更，否则不要绕过

## Git

当前工作目录中可能同时运行多个 pi 会话，每个会话修改不同的文件。触及自己变更之外的未暂存、已暂存或未跟踪文件的 Git 操作会破坏其他会话的工作。请遵循以下规则：

提交：

- 只提交**本**会话中**你**更改的文件
- 显式暂存路径（`git add <path1> <path2>`）；永远不要使用 `git add -A` / `git add .`
- 提交前运行 `git status` 并确认只暂存了你的文件
- `packages/ai/src/models.generated.ts` 可随时与你的文件一起包含
- 提交信息格式：`{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <提交信息>（可选多行）`。信息应提供信息且简洁

永远不要运行（会破坏其他代理的工作或绕过检查）：

- `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git add -A`、`git add .`、`git commit --no-verify`

如果出现变基冲突：

- 只解决你修改的文件中的冲突
- 如果冲突出现在你未修改的文件中，中止并询问用户
- 永远不要强制推送

## 议题与 PR

审查 PR 时：

- 除非用户明确要求，否则不要运行 `gh pr checkout`、`git switch` 或将工作树切换到 PR 分支
- 使用 `gh pr view`、`gh pr diff`、`gh api` 和本地的 `git show`/`git diff` 针对已获取的引用检查 PR 元数据、提交和补丁，无需切换分支
- 如果需要 PR 文件内容，将其获取/读取到临时文件中，或使用 `git show <ref>:<path>` 而不切换分支

创建议题时：

- 为受影响的包添加 `pkg:*` 标签（`pkg:agent`、`pkg:ai`、`pkg:coding-agent`、`pkg:tui`）；适用即添加

发布议题/PR 评论时：

- 将评论写入临时文件，使用 `gh issue/pr comment --body-file` 发布（永远不要通过 `--body` 传入多行 markdown）
- 保持评论简洁、技术性，使用用户的语气
- 在每条 AI 发布的评论末尾添加来源提示指定的 AI 生成免责声明行（例如 `` 此评论由 AI 生成 ``）

通过提交关闭议题时：

- 在提交信息中包含 `fixes #<number>` 或 `closes #<number>`，以便合并时自动关闭议题。对于多个议题，每个议题重复关键字（`closes #1, closes #2`）；共享关键字（`closes #1, #2`）只关闭第一个

## 使用 tmux 测试 pi 交互模式

在受控终端中运行 TUI（从仓库根目录）：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # 启动后捕获
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # 特殊按键（C-o 表示 ctrl+o 等）
tmux kill-session -t pi-test
```

## 变更日志

位置：`packages/*/CHANGELOG.md`（每个包一个）。

`## [Unreleased]` 下的章节：`### Breaking Changes`（需要迁移的 API 变更）、`### Added`、`### Changed`、`### Fixed`、`### Removed`。

规则：

- 所有新条目放在 `## [Unreleased]` 下。先完整阅读该章节，然后追加到现有子章节中；绝不重复
- 已发布版本的章节（例如 `## [0.12.2]`）不可变更；绝不修改它们

归属：

- 内部（来自议题）：`修复了 foo bar 问题 ([#123](https://github.com/A1exthegreat/pi/issues/123))`
- 外部贡献：`添加了功能 X ([#456](https://github.com/A1exthegreat/pi/pull/456)，作者 [@username](https://github.com/username))`

## 发布

**锁定版本同步**：所有包共享一个版本；每次发布一起更新所有包。`patch` = 修复与添加，`minor` = 破坏性变更。没有主版本。

1. **更新 CHANGELOG**：询问用户是否在 `main` 的最新提交上运行了 `/cl` 提示。如果没有，他们必须先运行 `/cl` 来审计并更新每个包的 `[Unreleased]` 章节，然后才能发布。

2. **本地冒烟测试**：构建一个未发布的版本并在仓库外部进行冒烟测试（使其无法解析工作空间文件）：
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node 包安装冒烟测试
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun 二进制冒烟测试
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   验证 Node 和 Bun 的启动、模型/账户列表、交互式启动，以及至少一个使用预期默认提供程序的真实提示。裸命令 `/tmp/pi-local-release/node/pi` 和 `/tmp/pi-local-release/bun/pi` 会启动交互模式；在每个命令下通过 tmux 运行，提交一个提示，等待模型回复后才能认为交互式冒烟测试通过。失败是发布阻塞项，除非用户明确接受风险。

3. **运行发布脚本**：
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # 修复与添加
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # 破坏性变更
   ```
   仅在发布命令中使用 `npm_config_min_release_age=0`。当当前工作空间包版本刚发布不久时，仓库正常的 npm 年龄门控可能会阻止发布 lockfile 刷新。在推送前审查发布创建的任何 lockfile 或 shrinkwrap 差异。

   发布脚本会：提升所有包版本、更新变更日志、重新生成发布产物、运行 `npm run check`、提交 `Release vX.Y.Z`、打标签 `vX.Y.Z`、添加新的 `## [Unreleased]` 变更日志章节、提交 `Add [Unreleased] section for next cycle`，然后推送 `main` 和标签。标签推送后不要重新运行发布脚本。

4. **CI 发布 npm 包**：推送 `vX.Y.Z` 标签会触发 `.github/workflows/build-binaries.yml`。`publish-npm` 任务使用通过 GitHub Actions OIDC 的 npm 信任发布，环境为 `npm-publish`；不需要本地 `npm publish`、`npm whoami`、OTP 或 WebAuthn 流程。

5. **如果 CI 发布失败**：检查失败的 `publish-npm` 任务。发布辅助函数是幂等的，会跳过已存在于 npm 上的包版本，因此在修复 CI 或临时 npm 问题后重新运行标签工作流。不要为同一版本重新运行 `npm run release:patch` 或 `npm run release:minor`。

## 用户覆盖

如果用户的指令与本文件中的任何规则冲突，请先请求显式确认再覆盖。只有在得到确认后才执行他们的指令。