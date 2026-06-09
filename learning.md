# Pi Agent Harness — 大模型 Agent 框架深度解析

> 本文档基于 pi-mono monorepo (`dev` 分支，`@earendil-works/pi-*` 系列包) 的源码编写。
> 覆盖包：`pi-ai` (多提供商 LLM API)、`pi-agent-core` (Agent 运行时)、`pi-coding-agent` (CLI 编码助手)、`pi-tui` (终端 UI)。

---

## 1. 整体架构

pi 的架构分为四个层次，从底层向上依次是：

```
┌──────────────────────────────────────────────────────────┐
│                    pi-coding-agent (CLI)                  │
│   参数解析、session管理、输出接管、模式选择(交互/print/RPC) │
├──────────────────────────────────────────────────────────┤
│                    pi-agent-core (Agent 运行时)            │
│   Agent 类、agent-loop（工具调用循环）、AgentHarness（     │
│   高层封装，含session持久化、compaction、hook事件体系）     │
├──────────────────────────────────────────────────────────┤
│              pi-ai (统一多提供商 LLM API)                  │
│   抽象 API 协议层 → 具体 Provider 实现 → SDK 调用          │
│   包括：模型注册表、API Key 解析、消息变换、事件流          │
├──────────────────────────────────────────────────────────┤
│              pi-tui (终端 UI 库)                           │
│   差分渲染终端、编辑器组件、markdown 渲染、输入系统         │
└──────────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户输入 → Agent.prompt() → runAgentLoop()
  → convertToLlm() [AgentMessage → Message]
  → streamSimple() [pi-ai: 调用 LLM API]
  → 流式返回 AssistantMessageEvent (text/thinking/toolCall)
  → tool call → executeToolCalls() → executePreparedToolCall()
  → ToolResultMessage → 循环调用 LLM 直到 stop
  → 持久化到 Session (JSONL)
```

---

## 2. pi-ai — 统一多提供商 LLM API

### 2.1 核心类型系统 (`types.ts`)

pi-ai 定义了完整的 LLM 交互类型体系：

| 类型 | 说明 |
|------|------|
| `Message` | 统一消息 = `UserMessage` \| `AssistantMessage` \| `ToolResultMessage` |
| `Context` | 请求上下文：systemPrompt + messages[] + tools[] |
| `Model<TApi>` | 模型描述：id, name, api, provider, baseUrl, cost, contextWindow, maxTokens |
| `StreamOptions` | 流式请求选项：temperature, maxTokens, signal, apiKey, transport, cacheRetention |
| `SimpleStreamOptions` | 简化流式选项，添加 reasoning (ThinkingLevel) |
| `StreamFunction` | 流式调用签名：`(Model, Context, Options?) → AssistantMessageEventStream` |

**关键的 `Model<TApi>` 类型**：

```typescript
interface Model<TApi extends Api> {
  id: string;           // 模型ID，如 "claude-sonnet-4-6-20250514"
  name: string;         // 可读名称
  api: TApi;            // API 协议类型，如 "anthropic-messages" | "openai-completions"
  provider: Provider;   // 提供商，如 "anthropic" | "openai"
  baseUrl: string;      // API 端点
  reasoning: boolean;   // 是否支持思考/推理
  thinkingLevelMap?: ThinkingLevelMap;  // 思考级别的映射
  input: ("text" | "image")[];  // 支持的输入模态
  cost: { input, output, cacheRead, cacheWrite };  // 每百万 token 费用
  contextWindow: number;
  maxTokens: number;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
}
```

### 2.2 模型注册表 (`models.ts` + `models.generated.ts`)

所有支持的模型在 `models.generated.ts` 中定义（自动生成），格式是：

```typescript
export const MODELS = {
  "anthropic": {
    "claude-sonnet-4-6-20250514": { id, name, api: "anthropic-messages", ... },
    "claude-3-5-sonnet-20241022": { ... },
  },
  "openai": {
    "gpt-4o": { id, name, api: "openai-completions", ... },
  },
  // 50+ providers...
}
```

`models.ts` 提供查找、成本计算、思考级别获取/裁剪等工具函数：

- `getModel(provider, modelId)` — 获取模型
- `getProviders()` — 所有提供商列表
- `getModels(provider)` — 提供商下的所有模型
- `calculateCost(model, usage)` — 计算费用
- `getSupportedThinkingLevels(model)` — 模型支持的思考级别
- `clampThinkingLevel(model, level)` — 将思考级别限制到模型支持的范围

### 2.3 API 注册中心 (`api-registry.ts`)

这是一个插件式的注册中心，将 **API 协议名称** 映射到实际的 **Provider 实现**：

```typescript
interface ApiProvider<TApi, TOptions> {
  api: TApi;              // 协议名称
  stream: StreamFunction; // 流式调用
  streamSimple: StreamFunction; // 简化流式调用
}

// 注册
registerApiProvider({ api: "anthropic-messages", stream: fn1, streamSimple: fn2 });
// 获取
getApiProvider("anthropic-messages");  // → ApiProviderInternal
// 清除（用于测试）
clearApiProviders();
```

### 2.4 Provider 实现

每个 Provider 实现一个 API 协议，将统一的 `Context` 和 `StreamOptions` 翻译成具体的 SDK 调用：

- **Anthropic** (`providers/anthropic.ts`) — 使用 `@anthropic-ai/sdk`，支持 `streamAnthropic()` 和 `streamSimpleAnthropic()`
- **OpenAI Completions** (`providers/openai-completions.ts`) — 使用 `openai` SDK，支持 `streamOpenAICompletions()` 和 `streamSimpleOpenAICompletions()`
- **OpenAI Responses** (`providers/openai-responses.ts`)
- **Google Gemini** (`providers/google.ts`)
- **AWS Bedrock** (`providers/amazon-bedrock.ts`)
- **Mistral**、**Azure OpenAI**、**OpenAI Codex**...

**懒加载机制** (`providers/register-builtins.ts`)：

Provider 模块通过 `createLazyStream()` 懒加载——只有首次调用某个 Provider 时，对应的模块才被 `import()` 加载。这避免了启动时加载所有 SDK：

```typescript
function loadAnthropicProviderModule() {
  anthropicProviderModulePromise ||= import("./anthropic.ts").then(m => ({
    stream: m.streamAnthropic,
    streamSimple: m.streamSimpleAnthropic,
  }));
  return anthropicProviderModulePromise;
}
```

所有 Provider 在模块加载时自动注册到 `api-registry`（通过 `registerBuiltInApiProviders()`）。

### 2.5 消息变换 (`providers/transform-messages.ts`)

在不同 Provider 之间传递消息时执行关键变换：

- **不支持的图像降级**：如果模型不支持图像输入 (model.input 不包含 "image")，将 ImageContent 替换为占位文本
- **Tool Call ID 规范化**：不同 API 的 tool call ID 格式不同（OpenAI Responses 生成 450+ 字符的 ID，包含特殊字符），需要映射为 Anthropic 兼容的短字母数字 ID
- **Thinking 块处理**：redacted thinking block 包含加密内容，只在同模型间有效，跨模型时丢弃

### 2.6 事件流系统 (`utils/event-stream.ts`)

这是 pi-ai 的核心异步抽象：

```typescript
class EventStream<T, R> implements AsyncIterable<T> {
  // 内部队列 + 等待消费者
  push(event: T): void;   // 生产者：推送事件
  end(result?: R): void;  // 生产者：结束流

  [Symbol.asyncIterator](): AsyncIterator<T>; // 消费者：异步迭代
  result(): Promise<R>;   // 获取最终结果
}
```

事件流模型：生产者在 `push()` 时，如果有消费者在等待 (`await`)，直接将事件投递；否则放入队列。消费者通过 `async iterator` 消费。实现了经典的 **push/pull 混合模型**。

`AssistantMessageEventStream` 发出的事件类型：

| 事件 | 含义 |
|------|------|
| `start` | 开始生成 |
| `text_start/delta/end` | 文本块 |
| `thinking_start/delta/end` | 思考块 |
| `toolcall_start/delta/end` | 工具调用块 |
| `done` | 正常结束 |
| `error` | 错误/中止 |

### 2.7 简易选项 (`providers/simple-options.ts`)

`streamSimple` 是 `stream` 的简化封装，自动处理 `reasoning`（思考级别）到具体 Provider 参数的转换：

```typescript
function buildBaseOptions(model, options, apiKey): StreamOptions
function adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens, reasoningLevel, customBudgets)
```

### 2.8 API Key 解析 (`env-api-keys.ts`)

为 50+ 个 Provider 定义环境变量映射（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`），支持 `process.env` 和 `/proc/self/environ`（Bun 兼容）。包含对 AWS Bedrock（多个认证源）、Google Vertex AI（ADC）的特殊处理。

### 2.9 简化的 stream/complet API (`stream.ts`)

暴露给上层使用的四个顶层函数：

```
stream(model, context, options?)        → AssistantMessageEventStream
complete(model, context, options?)      → Promise<AssistantMessage>
streamSimple(model, context, options?)  → AssistantMessageEventStream
completeSimple(model, context, options?)→ Promise<AssistantMessage>
```

`stream()` 从 `api-registry` 获取 Provider，自动注入 API Key (通过 `withEnvApiKey`)。

---

## 3. pi-agent-core — Agent 运行时：一次对话的完整生命周期

本节以一次完整的用户对话为例，从用户输入到最终输出，详细追溯 Agent 运行时的内部机制。所有代码均位于 `packages/agent/`。

### 3.1 AgentMessage 扩展体系 (`harness/messages.ts`)

Agent 运行时在基本的 `Message`（user / assistant / toolResult）之上，通过 TypeScript `declaration merging` 扩展了多种自定义消息类型，构成 `AgentMessage` 联合类型：

```typescript
// 自定义消息类型扩展
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;        // 执行的命令
  output: string;         // 执行输出
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // 是否从 LLM 上下文中排除
}

export interface CustomMessage<T> {
  role: "custom";         // 通用自定义消息
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
}

export interface BranchSummaryMessage {
  role: "branchSummary";  // 分支摘要（会话树导航时生成）
  summary: string;
  fromId: string;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";  // 上下文压缩摘要
  summary: string;
  tokensBefore: number;
}
```

**`convertToLlm()` 函数** 是 Agent 层的核心桥接函数，将各种 `AgentMessage` 转换为 LLM 可理解的 `Message`：

```typescript
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.map(m => {
    switch (m.role) {
      case "bashExecution":
        // 将 Bash 执行结果渲染为 UserMessage 文本
        return { role: "user", content: [{ type: "text", text: bashExecutionToText(m) }] };
      case "branchSummary":
        // 将分支摘要包装在 <summary> XML tag 中
        return { role: "user", content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }] };
      case "user":
      case "assistant":
      case "toolResult":
        return m;  // 直接透传
      // ...其他类型类似处理
    }
  }).filter(Boolean);
}
```

### 3.2 完整对话生命周期 — 分阶段详解

#### 阶段 1: 启动 — `Agent.prompt()` 入口

用户向 Agent 发送消息，调用路径为 `Agent.prompt()`：

```typescript
class Agent {
  async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
    // 检查是否有活跃运行
    if (this.activeRun) throw new Error("Agent is already processing...");
    const messages = this.normalizePromptInput(input, images);  // → UserMessage[]
    await this.runPromptMessages(messages);
  }

  private async runPromptMessages(messages, options = {}): Promise<void> {
    // 创建运行生命周期
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,                // 用户输入消息
        this.createContextSnapshot(),  // 当前上下文(systemPrompt + messages + tools)
        this.createLoopConfig(options), // 循环配置(模型、钩子、队列...)
        (event) => this.processEvents(event),  // 事件处理器
        signal,
        this.streamFn,           // 流函数(默认为 streamSimple)
      );
    });
  }
}
```

`runWithLifecycle()` 创建 `AbortController`，设置 `isStreaming = true`，然后在 `finally` 块中清理运行状态。这确保了即使抛出异常，Agent 也不会"卡"在忙碌状态。

#### 阶段 2: 进入 Agent Loop — `runAgentLoop()`

`agent-loop.ts` 中的 `runAgentLoop()` 是对话调度的中枢：

```typescript
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  // 发出生命周期事件
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  // 进入核心循环
  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}
```

#### 阶段 3: 核心循环 — `runLoop()`

`runLoop()` 采用**双层循环**架构：

```
外层循环 (while true):
  负责检查 follow-up 消息
  如果 follow-up 队列有消息 → 设为 pending → 继续内层循环
  如果没有 → 结束循环 → emit agent_end

内层循环 (while hasMoreToolCalls || pendingMessages.length > 0):
  1. 注入 pending 消息（steering 消息）
  2. 调用 streamAssistantResponse() ← 实际 LLM 调用
  3. 检查 stopReason === "error" → 返回
  4. 提取 tool calls
  5. 如果有 tool calls → executeToolCalls()
  6. emit turn_end
  7. prepareNextTurn() 钩子（可更换 model/context/thinkingLevel）
  8. shouldStopAfterTurn() 钩子
  9. 检查 steering messages → 继续或退出内层
```

关键代码（简化）：

```typescript
async function runLoop(initialContext, newMessages, initialConfig, signal, emit, streamFn) {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  while (true) {  // 外层：follow-up 循环
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {  // 内层：工具+steering 循环
      // 注入 pending 消息
      if (pendingMessages.length > 0) {
        for (const msg of pendingMessages) {
          await emit({ type: "message_start", message: msg });
          await emit({ type: "message_end", message: msg });
          currentContext.messages.push(msg);
          newMessages.push(msg);
        }
        pendingMessages = [];
      }

      // ★ LLM 调用
      const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
      newMessages.push(message);

      if (message.stopReason === "error") return;

      // ★ 工具执行
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      if (toolCalls.length > 0) {
        const executed = await executeToolCalls(currentContext, message, config, signal, emit);
        // 工具结果追加到上下文
        for (const result of executed.messages) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
        hasMoreToolCalls = !executed.terminate;
      }

      await emit({ type: "turn_end", message, toolResults });
      // prepareNextTurn / shouldStopAfterTurn 钩子
      // ...
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 外层：检查 follow-up
    const followUps = (await config.getFollowUpMessages?.()) || [];
    if (followUps.length > 0) {
      pendingMessages = followUps;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

#### 阶段 4: LLM 调用 — `streamAssistantResponse()`

这是 Agent 调用 LLM 的核心步骤：

```typescript
async function streamAssistantResponse(context, config, signal, emit, streamFn) {
  // 1. transformContext — AgentMessage 级别的上下文变换
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // 2. convertToLlm — AgentMessage → Message（关键桥接）
  const llmMessages = await config.convertToLlm(messages);

  // 3. 构建 LLM Context
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,  // 工具定义传给 LLM
  };

  // 4. 解析 API Key（支持 OAuth 动态刷新）
  const resolvedApiKey = (config.getApiKey?.(config.model.provider)) || config.apiKey;

  // 5. 调用 LLM 流式 API
  const response = await (streamFn || streamSimple)(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  // 6. 流式事件处理
  let partialMessage = null;
  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);  // 追加到上下文
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;
      case "text_delta":
      case "toolcall_delta":
        // 实时更新消息
        partialMessage = event.partial;
        context.messages[context.messages.length - 1] = partialMessage;
        await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
        break;
      case "done":
      case "error":
        const finalMessage = await response.result();
        context.messages[context.messages.length - 1] = finalMessage;
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
    }
  }
}
```

#### 阶段 5: 工具调用执行 — `executeToolCalls()`

当 LLM 返回 `toolCalls` 时，进入工具执行阶段：

```typescript
async function executeToolCalls(currentContext, assistantMessage, config, signal, emit) {
  const toolCalls = assistantMessage.content.filter(c => c.type === "toolCall");

  // 检查是否有顺序执行的工具
  const hasSequential = toolCalls.some(tc =>
    currentContext.tools?.find(t => t.name === tc.name)?.executionMode === "sequential"
  );

  // 选择执行模式
  if (config.toolExecution === "sequential" || hasSequential) {
    return executeToolCallsSequential(...);
  }
  return executeToolCallsParallel(...);
}
```

**顺序执行 (`executeToolCallsSequential`)**：

对每个工具调用：
1. `emit("tool_execution_start")` ← 通知 UI
2. `prepareToolCall()` — 查找工具定义、验证参数 (JSON Schema)、触发 `beforeToolCall` 钩子
3. 如果准备阶段返回 `immediate`（工具未找到/被阻止/参数无效）→ 直接使用错误结果
4. 否则 → `executePreparedToolCall()` → 实际执行工具
5. `finalizeExecutedToolCall()` → 触发 `afterToolCall` 钩子
6. `emit("tool_execution_end")` → `createToolResultMessage()` → `ToolResultMessage`
7. 检查 `signal?.aborted` — 如果中止则跳出

**并行执行 (`executeToolCallsParallel`)**：

关键在于**预检查顺序执行，execute 阶段并行**：

```typescript
async function executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit) {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, ... });

    const preparation = await prepareToolCall(...);  // 顺序预检查
    if (preparation.kind === "immediate") {
      // 立即失败的工具直接推入结果
      finalizedCalls.push(/* 直接 finalized */);
      continue;
    }

    // 需执行的工具包装为异步函数
    finalizedCalls.push(async () => {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(...);
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
  }

  // ★ 并行执行所有工具，但结果按原始顺序排列
  const orderedFinalizedCalls = await Promise.all(
    finalizedCalls.map(entry => typeof entry === "function" ? entry() : Promise.resolve(entry))
  );

  // 按原始顺序发出 ToolResultMessage
  const messages = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
  };
}
```

并行执行的巧妙点：
- `prepareToolCall()` 顺序执行确保 `beforeToolCall` 钩子按序触发，参数验证隔离
- 但 tools 的 `execute()` 阶段可以并行运行
- `Promise.all` 等待所有工具完成，但 `finalizedCalls` 数组顺序 = 原始 `toolCalls` 顺序
- 所以 `ToolResultMessage` 按工具调用的原始顺序排列

#### 阶段 6: 工具执行内部细节

**`prepareToolCall()`**：

```typescript
async function prepareToolCall(currentContext, assistantMessage, toolCall, config, signal) {
  // 1. 查找工具定义
  const tool = currentContext.tools?.find(t => t.name === toolCall.name);
  if (!tool) return { kind: "immediate", result: errorResult, isError: true };

  // 2. 参数准备（兼容性 shim）
  const preparedToolCall = prepareToolCallArguments(tool, toolCall);
  // 3. 参数验证（JSON Schema）
  const validatedArgs = validateToolArguments(tool, preparedToolCall);
  // 4. beforeToolCall 钩子（可阻止执行）
  if (config.beforeToolCall) {
    const beforeResult = await config.beforeToolCall({ args: validatedArgs, ... });
    if (beforeResult?.block) return { kind: "immediate", result: blockedResult, isError: true };
  }
  // 5. 返回 PreparedToolCall 供后续执行
  return { kind: "prepared", toolCall, tool, args: validatedArgs };
}
```

**`executePreparedToolCall()`**：

```typescript
async function executePreparedToolCall(prepared, signal, emit) {
  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partialResult) => {
        // onUpdate 回调：发送部分执行更新
        emit({ type: "tool_execution_update", toolCallId, toolName, args, partialResult });
      }
    );
    return { result, isError: false };
  } catch (error) {
    return { result: errorResult, isError: true };
  }
}
```

**`finalizeExecutedToolCall()`**：

```typescript
async function finalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, signal) {
  let result = executed.result;
  let isError = executed.isError;

  // afterToolCall 钩子：应用层可修改结果
  if (config.afterToolCall) {
    const afterResult = await config.afterToolCall({ result, isError, ... });
    if (afterResult) {
      result = {
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
        terminate: afterResult.terminate ?? result.terminate,
      };
      isError = afterResult.isError ?? isError;
    }
  }
  return { toolCall: prepared.toolCall, result, isError };
}
```

### 3.3 Agent 类整体架构 (`agent.ts`)

`Agent` 类是对底层 `agent-loop.ts` 的封装，提供：

- **状态管理** (`MutableAgentState`) — 包含 systemPrompt、model、thinkingLevel、tools、messages、isStreaming
- **消息队列** — `steer()` / `followUp()` 队列
- **事件订阅** — `subscribe()` 返回 unsubscribe 函数
- **运行时管理** — `abort()`、`reset()`、`waitForIdle()`
- **多轮对话** — `prompt()` 发起新对话，`continue()` 从已有上下文继续

**消息队列机制详解**：

```typescript
class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  public mode: QueueMode;  // "all" | "one-at-a-time"

  enqueue(message: AgentMessage): void { this.messages.push(message); }
  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    this.messages = this.messages.slice(1);
    return first ? [first] : [];
  }
}
```

- **steering 队列**：在当前回合工具执行完成后、下回合 LLM 调用前注入
  - 默认模式: `"one-at-a-time"`（一次只注入一条）
  - 典型用途：用户输入中断、新指令
- **followUp 队列**：Agent 将要停止（steering 队列为空且无工具调用）时注入
  - 默认模式: `"one-at-a-time"`
  - 典型用途：自动纠正、后续步骤

### 3.4 AgentEvent 事件体系

完整的生命周期事件链：

```
Agent 级别:
  agent_start                         → prompt() 调用开始
  agent_end                           → prompt() 调用结束

Turn 级别 (一次 LLM 调用 + 工具执行回合):
  turn_start                          → 新回合开始
  turn_end                            → 回合结束，包含 message + toolResults

消息级别:
  message_start                       → 消息开始
  message_update                      → 消息更新（仅流式 assistant 消息）
  message_end                         → 消息完成

工具执行级别:
  tool_execution_start                → 工具开始执行
  tool_execution_update               → 部分执行更新
  tool_execution_end                  → 工具执行结束，包含 result + isError
```

### 3.5 单次对话完整时间线

```
Agent.prompt("帮我写一个 Python 脚本")
  │
  ├─ agent_start
  ├─ turn_start
  ├─ message_start (UserMessage: "帮我写一个 Python 脚本")
  ├─ message_end
  │
  ├─ streamAssistantResponse()
  │   ├─ transformContext → convertToLlm → streamSimple
  │   ├─ message_start (AssistantMessage, partial)
  │   ├─ text_delta "我来帮你..."
  │   ├─ message_update (partial)
  │   ├─ text_delta "这是一个脚本..."
  │   ├─ toolcall_start (toolCall: Bash)
  │   ├─ toolcall_delta
  │   ├─ toolcall_end (toolCall: Bash, args: {command: "python3 ..."})
  │   └─ message_end (AssistantMessage, stopReason: toolUse)
  │
  ├─ executeToolCalls()
  │   ├─ tool_execution_start (Bash)
  │   ├─ prepareToolCall → 验证参数、beforeToolCall 钩子
  │   ├─ tool_execution_update (partial stdout)
  │   ├─ tool_execution_end (result: {content: "Hello World"})
  │   └─ message_start/message_end (ToolResultMessage)
  │
  ├─ turn_end
  │
  ├─ (steering 消息检查 → 无)
  │
  ├─ streamAssistantResponse()  ← 第二次 LLM 调用
  │   └─ 模型看到 UserMessage + AssistantMessage(toolUse) + ToolResultMessage
  │
  ├─ text_delta "脚本已创建..."
  ├─ message_end (stopReason: stop)
  │
  ├─ turn_end
  ├─ (steering → 无, follow-up → 无)
  └─ agent_end
```

### 3.6 AgentHarness (`harness/agent-harness.ts`)

`AgentHarness` 是 Agent 的高层封装，增加了生产级特性。与 `Agent` 类的核心区别：

```
Agent 类              AgentHarness
────────────────────────────────────────────────────
简单状态管理           Session 持久化（JSONL）
无 Hook 机制           Hook 事件体系（20+ 事件点）
无 Compaction          Compaction（上下文压缩）
无分支管理             分支导航 + 摘要
无技能系统              技能注入 + 提示词模板
```

**AgentHarness 关键功能**：

1. **会话持久化**：
   ```typescript
   private pendingSessionWrites: PendingSessionWrite[] = [];
   // 运行时缓存写入，在 safe points 批量刷新
   async flushPendingSessionWrites() {
     while (this.pendingSessionWrites.length > 0) {
       const write = this.pendingSessionWrites[0];
       if (write.type === "message") await this.session.appendMessage(write.message);
       else if (write.type === "model_change") await this.session.appendModelChange(...);
       // ...
     }
   }
   ```

2. **Hook 事件体系**：AgentHarness 定义了完整的钩子生命周期：

   | 事件名 | 时机 | 返回值 |
   |--------|------|--------|
   | `before_agent_start` | Agent 开始前 | 可修改 messages/systemPrompt |
   | `context` | 消息送入 LLM 前 | 可修改 messages |
   | `before_provider_request` | 发请求前 | 可修改 streamOptions |
   | `before_provider_payload` | 载荷发送前 | 可修改 payload |
   | `after_provider_response` | 收到响应后 | 无 |
   | `tool_call` | 工具调用前 | 可阻止工具 |
   | `tool_result` | 工具执行后 | 可修改结果 |
   | `session_before_compact` | 压缩前 | 可取消或提供结果 |
   | `session_before_tree` | 分支导航前 | 可取消或提供摘要 |

3. **Compaction** (`compact()`): 当上下文 Token 接近限制时，将早期消息压缩为摘要：
   - `prepareCompaction()` — 找出要压缩的消息
   - `compact()` — 使用 LLM 生成摘要，保留最近的若干轮
   - 写入 `CompactionEntry` 到 Session

4. **分支导航** (`navigateTree()`): 在 JSONL 会话树中跳转到不同位置，支持分支摘要：
   - `collectEntriesForBranchSummary()` — 收集未读分支中的条目
   - `generateBranchSummary()` — 使用 LLM 生成分支摘要
   - `session.moveTo()` — 更新 Leaf ID，写入 `BranchSummaryMessage`

5. **流配置管线**：
   ```typescript
   // createStreamFn() 构建流函数管线：
   // 1. 获取 API Key 和自定义 Headers
   // 2. emit before_provider_request (可修改选项)
   // 3. onPayload 钩子 (可修改载荷)
   // 4. onResponse 钩子 (记录响应)
   // 5. 最终调用 streamSimple()
   ```

**通过 Hook 扩展的示例**：

```typescript
// 在 CLI 层注册钩子
harness.on("tool_call", async (event) => {
  if (event.toolName === "Bash") {
    // 实时显示执行的命令
    renderToolCall(event.toolCallId, event.input);
  }
});

harness.on("before_provider_request", async (event) => {
  // 动态注入请求头
  if (event.model.provider === "anthropic") {
    return { streamOptions: { headers: { "x-api-key": "..." } } };
  }
});
```

---

## 4. pi-coding-agent — CLI 编码助手深入解析

本节详细剖析 `pi coding-agent` 的 CLI 层实现。所有代码位于 `packages/coding-agent/src/`。CLI 层是 Agent 运行时面向用户的封装，负责参数解析、服务初始化和多模式运行调度。

### 4.1 整体架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        pi-coding-agent CLI                              │
│                                                                          │
│  main.ts (入口点)                                                        │
│    ├─ parseArgs()                    → cli/args.ts                       │
│    ├─ createSessionManager()         → 打开/创建/恢复 JSONL Session     │
│    ├─ createAgentSessionRuntime()    → 创建 AgentSessionRuntime          │
│    └─ 进入运行模式:                                                      │
│         ├─ InteractiveMode (交互式 TUI)                                  │
│         ├─ runPrintMode (非交互式单次执行)                               │
│         └─ runRpcMode (JSON-RPC 协议)                                   │
│                                                                          │
│  AgentSession (核心会话抽象)                                              │
│    ├─ Agent 实例管理                                                      │
│    ├─ Event 订阅 + 会话持久化                                            │
│    ├─ Model/ThinkingLevel 管理                                           │
│    ├─ Compaction (手动/自动)                                            │
│    ├─ Bash 执行                                                         │
│    ├─ 会话切换和分支                                                     │
│    └─ Extension 系统集成                                                 │
│                                                                          │
│  AgentSessionRuntime (运行时包装)                                         │
│    ├─ 持有 cwd-bound 服务                                                 │
│    ├─ 会话替换 (newSession/fork/switch)                                 │
│    └─ dispose 清理                                                      │
│                                                                          │
│  AgentSessionServices (服务容器)                                          │
│    ├─ AuthStorage (API Key/OAuth)                                       │
│    ├─ ModelRegistry (模型查询)                                           │
│    ├─ SettingsManager (设置)                                            │
│    ├─ SessionManager (JSONL 持久化)                                     │
│    ├─ ResourceLoader (扩展/技能/主题加载)                                │
│    └─ KeybindingsManager (快捷键)                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.2 入口流程详解 (`main.ts`)

`main()` 函数是 CLI 的完整入口，流程非常精细，分为以下阶段：

#### 阶段 1: 启动前置

```typescript
export async function main(args: string[], options?: MainOptions) {
  // 1. 离线模式检测
  const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
  if (offlineMode) { process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; }

  // 2. Windows 自更新清理
  if (process.platform === "win32") { cleanupWindowsSelfUpdateQuarantine(getPackageDir()); }

  // 3. 包管理命令拦截 (pi install xxx, pi update --self)
  if (await handlePackageCommand(args)) return;

  // 4. 配置命令拦截 (pi config set xxx yyy)
  if (await handleConfigCommand(args)) return;

  // 5. 参数解析
  const parsed = parseArgs(args);
  // ...
}
```

#### 阶段 2: 模式决议

`resolveAppMode()` 根据 CLI 参数和 stdin 状态决定运行模式：

```typescript
function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
  if (parsed.mode === "rpc")    return "rpc";
  if (parsed.mode === "json")   return "json";
  if (parsed.print || !stdinIsTTY) return "print";  // 管道输入 → 非交互模式
  return "interactive";
}
```

四种模式的选择逻辑：
| 模式 | 触发条件 | 行为 |
|------|---------|------|
| `interactive` | 终端 TTY + 无 `--print`/`--mode` 标志 | 全屏 TUI，实时渲染 |
| `print` | `--print` 或 stdin 有管道输入 | 发送 prompt，输出最终结果后退出 |
| `json` | `--mode json` | 同 print 但输出 JSON 事件流 |
| `rpc` | `--mode rpc` | JSON-RPC 协议，stdin/stdout 通信 |

#### 阶段 3: Session 管理器创建

`createSessionManager()` 包含精细的会话选择逻辑（约 100 行），处理七种会话操作模式：

```typescript
async function createSessionManager(parsed, cwd, sessionDir, settingsManager): Promise<SessionManager> {
  if (parsed.noSession)  return SessionManager.inMemory();     // 无持久化
  if (parsed.fork)       return forkSessionOrExit(...);        // 从现有 session fork
  if (parsed.session)    return openExistingSession(...);       // 打开已有 session
  if (parsed.resume)     return selectAndOpenSession(...);      // TUI 选择 session
  if (parsed.continue)   return SessionManager.continueRecent(); // 恢复最近的 session
  if (parsed.sessionId)  return findOrCreateById(...);          // 按 ID 查找
  return SessionManager.create();                                // 创建新 session
}
```

会话文件使用 `.jsonl` 格式存储，每条记录是一个 `SessionTreeEntry`。

#### 阶段 4: 项目信任提示

对于包含 `AGENTS.md`/`CLAUDE.md` 的项目目录，首次运行会弹出信任对话框：

```typescript
const selected = await promptForProjectTrust(cwd, settingsManager);
// 选项: "Trust" | "Trust (this session only)" | "Do not trust" | "Do not trust (this session only)"
if (selected.remember) { trustStore.set(cwd, selected.trusted); }
```

未信任时，项目本地设置、扩展、资源不会被加载。

#### 阶段 5: Runtime 创建 (`createAgentSessionRuntime`)

`createRuntime` 工厂函数闭包捕获所有 CLI 参数，按需创建 cwd-bound 服务：

```typescript
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
  const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const services = await createAgentSessionServices({
    cwd, agentDir, authStorage,
    settingsManager: runtimeSettingsManager,
    resourceLoaderOptions: { /* 扩展/技能/主题路径 */ },
  });

  const scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
  const { options: sessionOptions } = buildSessionOptions(parsed, scopedModels, ...);

  const created = await createAgentSessionFromServices({
    services, sessionManager, model: sessionOptions.model,
    thinkingLevel: sessionOptions.thinkingLevel,
    scopedModels: sessionOptions.scopedModels,
    tools: sessionOptions.tools, excludeTools: sessionOptions.excludeTools,
    noTools: sessionOptions.noTools,
  });
  return { ...created, services, diagnostics };
};
```

#### 阶段 6: 进入运行模式

```typescript
if (appMode === "rpc") {
  printTimings();
  await runRpcMode(runtime);
} else if (appMode === "interactive") {
  const interactiveMode = new InteractiveMode(runtime, {
    migratedProviders, modelFallbackMessage,
    initialMessage, initialImages, initialMessages: parsed.messages,
  });
  printTimings();
  await interactiveMode.run();
} else {
  printTimings();
  const exitCode = await runPrintMode(runtime, {
    mode: toPrintOutputMode(appMode),
    messages: parsed.messages, initialMessage, initialImages,
  });
}
```

### 4.3 CLI 参数解析 (`cli/args.ts`)

`parseArgs()` 是手写的参数解析器，支持：

```typescript
export interface Args {
  provider?: string;             // --provider anthropic
  model?: string;                // --model claude-sonnet-4-6-20250514
  apiKey?: string;               // --api-key xxx
  systemPrompt?: string;         // --system-prompt "you are..."
  thinking?: ThinkingLevel;      // --thinking medium
  continue?: boolean;            // -c, --continue
  resume?: boolean;              // -r, --resume
  session?: string;              // --session <id|path>
  sessionId?: string;            // --session-id <uuid>
  fork?: string;                 // --fork <id|path>
  models?: string[];             // --models "anthropic/claude-sonnet-4-6-20250514" ...
  tools?: string[];              // --tools read,bash
  noTools?: boolean;             // --no-tools
  extensions?: string[];         // --extensions <path>
  skills?: string[];            // --skills <path>
  // ...30+ 个参数
}
```

支持 `--model` 的模式匹配语法：`<provider>/<model-pattern>[:<thinking-level>]`，例如 `anthropic/*:high`。

### 4.4 SDK (`core/sdk.ts`)

`createAgentSession()` 是组装 AgentSession 的核心工厂，负责：

1. **模型选择**: 从 CLI 参数、设置、作用域模型列表中确定使用的模型
2. **思考级别确定**: 从 CLI、模型模式、设置中确定推理深度
3. **工具管理**: 构建内置工具列表 (read, bash, edit, write, grep, find, ls)
4. **资源加载**: 加载扩展、技能、提示模板、主题
5. **事件绑定**: 将 Agent 事件连接到会话持久化和扩展系统

```typescript
export interface CreateAgentSessionOptions {
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
  noTools?: "all" | "builtin";
  tools?: string[];
  excludeTools?: string[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
}
```

### 4.5 AgentSession (`core/agent-session.ts`)

`AgentSession` 是所有运行模式共享的核心会话抽象。它是 Agent 的高层封装，文档第一句清晰地说明了职责：

```typescript
/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 * This class is shared between all run modes (interactive, print, rpc).
 *
 * Modes use this class and add their own I/O layer on top.
 */
```

关键职责：

1. **Agent 实例管理**: 持有 `Agent` 实例和 `AgentHarness`
2. **事件订阅 + 自动持久化**: 监听 Agent 事件，自动写入 JSONL Session
3. **Model/ThinkingLevel 管理**: 切换模型和思考级别时自动持久化，并重新绑定工具
4. **Compaction**: 手动触发或基于上下文 token 计数自动触发
5. **Bash 执行**: 生成 `BashExecutionMessage`，跟踪文件变更
6. **会话切换和分支**: 支持 `fork`、`switch`、`newSession` 操作
7. **Extension 集成**: 事件桥接、命令上下文、UI 请求

### 4.6 AgentSessionRuntime (`core/agent-session-runtime.ts`)

`AgentSessionRuntime` 包装当前 `AgentSession` 和它的 cwd-bound 服务，支持会话热替换：

```typescript
export class AgentSessionRuntime {
  private _session: AgentSession;
  private _services: AgentSessionServices;
  private readonly createRuntime: CreateAgentSessionRuntimeFactory;

  // 新建会话 — 销毁当前运行时，用新的 cwd/services 重建
  async newSession(options?: NewSessionOptions): Promise<void> {
    const { cwd, sessionManager } = options;
    const result = await this.createRuntime({ cwd, agentDir, sessionManager });
    await this.replaceSession(result);
  }

  // Fork 会话 — 从当前或指定 entry 创建分支
  async fork(entryId?: string, forkOptions?: {...}): Promise<...>;

  // 切换到另一会话
  async switch(targetCwd, targetSessionManager): Promise<...>;
}
```

### 4.7 运行模式详解

#### 4.7.1 InteractiveMode (`modes/interactive/interactive-mode.ts`)

交互模式是功能最完整的运行模式，约数千行代码，使用 `pi-tui` 作为 UI 框架：

```typescript
// 初始化
const interactiveMode = new InteractiveMode(runtime, {
  migratedProviders, modelFallbackMessage,
  initialMessage, initialImages,
});
await interactiveMode.run();
```

交互模式的组件树：

```
TUI (Terminal UI 实例)
├── EditorComponent (编辑器 — 用户输入)
│   ├── AutocompleteProvider (命令补全)
│   ├── SlashCommand 处理 (/help, /model, /compact...)
│   └── Keybinding 处理 (Ctrl+P 切换模型...)
├── Markdown / AssistantMessageComponent (消息渲染)
│   ├── BashExecutionComponent (Bash 执行结果)
│   ├── ToolExecutionComponent (工具调用)
│   ├── DiffComponent (代码差异显示)
│   └── SyntaxHighlight (代码高亮)
├── Footer (状态栏)
│   ├── 模型名称
│   ├── Token 计数
│   └── 费用显示
├── 选择器组件
│   ├── SessionSelector (会话选择)
│   ├── ModelSelector (Ctrl+P 模型切换)
│   ├── ThinkingSelector (思考级别选择)
│   ├── ConfigSelector (配置设置)
│   ├── ThemeSelector (主题选择)
│   └── TrustSelector (项目信任)
└── Loader / BorderedLoader (加载动画)
```

消息渲染组件 (`modes/interactive/components/assistant-message.ts`) 负责：
- 流式渲染 assistant 消息的 text/thinking/toolCall 块
- 实时更新 delta 内容
- 代码高亮 (使用 highlight.js)
- 文本截断和展开

**快捷键系统**：`KeybindingsManager` 管理近百个快捷键绑定，支持：
- `Ctrl+Enter` — 提交输入
- `Ctrl+P` — 模型选择器
- `Ctrl+I` — 思考级别切换
- `Ctrl+L` — 清屏
- `/help`、`/compact`、`/model` 等斜杠命令

**扩展 UI**：Extension 系统可以通过 `ExtensionUIContext` 集成自定义 UI 组件：
- 自定义编辑器 (`EditorFactory`)
- 自动补全提供者 (`AutocompleteProviderFactory`)
- 对话框 (`ExtensionUIDialogOptions`)
- 小部件 (`ExtensionWidgetOptions`)

#### 4.7.2 PrintMode (`modes/print-mode.ts`)

非交互式单次执行模式：

```
pi -p 'explain this code'    # 文本输出 → 打印最终 assistant 消息
echo 'hello' | pi             # 管道输入 → 自动进入 print 模式
pi --mode json 'prompt'       # JSON 事件流 → 输出结构化的 AgentEvent
```

核心实现：

```typescript
export async function runPrintMode(runtimeHost, options): Promise<number> {
  // 注册信号处理 (SIGTERM, SIGHUP)
  // 绑定 session 事件 → 输出到 stdout
  // 发送 initialMessage → 等待完成
  // 可选发送更多 messages[]
  // 输出最终 assistant 消息文本或 JSON 事件流
  // 清理资源
}
```

JSON 模式输出事件流示例：
```json
{"type":"agent_start"}
{"type":"message_start","message":{...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...}}
{"type":"agent_end","messages":[...]}
```

#### 4.7.3 RPCMode (`modes/rpc/rpc-mode.ts`)

JSON-RPC 协议模式，用于嵌入到其他应用：

- **输入 (stdin)**: JSON 命令对象，带 `type` 字段和可选 `id`
- **输出 (stdout)**: JSON 行协议，每行一个对象
- **支持的命令**: `prompt`, `continue`, `abort`, `model`, `thinking`, `tools`, `session`, `fork`, `switch`, `skills`, `steer`, `followUp`, `keys`

```typescript
// 命令示例
{ "id": "1", "type": "prompt", "content": "Hello" }
// 响应示例
{ "id": "1", "type": "response", "command": "prompt", "success": true, "data": { "message": "..." } }
// 事件示例（流式输出）
{ "type": "agent_start" }
{ "type": "message_start", "role": "assistant", ... }
```

RPC 模式的关键设计——**Extension UI 请求转发**：
当扩展需要 UI 交互（如对话框、widget 选择）时，RPC 模式不能直接渲染 UI。因此将这些 UI 请求序列化为 JSON 输出，等待客户端通过 `extension_ui_response` 回复：

```typescript
const requestId = crypto.randomUUID();
pendingExtensionRequests.set(requestId, { resolve, reject });
output({
  type: "extension_ui_request",
  requestId,
  source: "dialog",
  options: { title, message, ... }
});
```

### 4.8 Extension 系统 (`core/extensions/`)

完整的插件系统，支持在 Agent 生命周期各个阶段注入自定义行为。

#### 4.8.1 架构

```
Extension 生命周期:
  发现 → 加载 → 注册 → 事件路由

Extension 可以发现:
  1. 项目本地:  .pi/extensions/ 目录
  2. 全局:      ~/.pi/agent/extensions/
  3. CLI 参数:   --extensions <path>
  4. Package:   npm install 安装的扩展包
```

#### 4.8.2 Extension 接口 (`extensions/types.ts`)

```typescript
export interface Extension {
  name: string;
  version?: string;

  // 工具注册 — 可定义自定义工具
  provideTools?(): ToolDefinition[];

  // 生命周期钩子 — 订阅各种事件
  onBeforeAgentStart?(event: BeforeAgentStartEvent): BeforeAgentStartEventResult | void;
  onContext?(event: ContextEvent): ContextEventResult | void;
  onProviderRequest?(event: BeforeProviderRequestEvent): BeforeProviderRequestEventResult | void;
  onMessage?(event: MessageStartEvent | MessageUpdateEvent | MessageEndEvent): void;
  onToolCall?(event: ToolCallEvent): ToolCallEventResult | void;
  onToolResult?(event: ToolResultEvent): ToolResultEventResult | void;
  // ... 30+ 生命周期钩子

  // UI 集成
  provideEditor?(): EditorFactory;
  provideAutocomplete?(): AutocompleteProviderFactory;
  provideKeybindings?(): AppKeybinding[];
  provideCommands?(): ExtensionCommand[];
  provideWidgets?(): ExtensionWidgetOptions[];
}
```

#### 4.8.3 ExtensionRunner (`extensions/runner.ts`)

运行时负责：
1. **事件路由**: 将 Agent 事件分发给所有订阅的扩展
2. **资源管理**: 管理快捷键冲突、命令命名空间
3. **UI 桥接**: 在交互模式和 RPC 模式下桥接 UI 请求

事件优先级：扩展钩子的处理链从先注册到后注册依次执行，每个钩子都可以修改事件上下文。

### 4.9 系统提示词构建 (`core/system-prompt.ts`)

`buildSystemPrompt()` 根据工具选择、项目上下文和自定义设置构建系统提示词：

```typescript
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  // 1. 工具列表 — 已选工具的一行摘要
  //    - read: 读取文件
  //    - bash: 执行命令
  //    - edit: 编辑文件
  //    - write: 写文件

  // 2. 使用指南 — 基于已选工具的指导方针
  //    - 读取 → 搜索 → 编辑 工作流
  //    - Bash 安全告诫
  //    - 图像处理指南

  // 3. 项目上下文 — AGENTS.md/CLAUDE.md
  //    从项目目录向上搜索到根目录加载

  // 4. Skills — SKILL.md 文件
  //    可选的技能描述，当读工具可用时注入

  // 5. 自定义提示 — --system-prompt / --append-system-prompt
}
```

项目上下文加载器 (`core/resource-loader.ts`)：
- 从 `~/.pi/agent/` 加载全局 `AGENTS.md`/`CLAUDE.md`
- 从项目目录向上遍历到根目录加载所有上下文文件
- 检查 `projectTrusted` 状态决定是否加载项目本地文件
- 从 `.pi/skills/` 目录加载 `SKILL.md`

### 4.10 服务容器 (`core/agent-session-services.ts`)

`createAgentSessionServices()` 创建所有运行时服务：

```typescript
export async function createAgentSessionServices(options: {
  cwd: string;
  agentDir: string;
  authStorage: AuthStorage;
  settingsManager: SettingsManager;
  extensionFlagValues?: Map<string, boolean | string>;
  resourceLoaderOptions: ResourceLoaderOptions;
}): Promise<AgentSessionServices> {
  const services = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    authStorage: options.authStorage,
    settingsManager: options.settingsManager,
    modelRegistry: await ModelRegistry.create(options.authStorage),
    sessionManager: ...,       // 由外部传入
    resourceLoader: resourceLoader,
    keybindingsManager: KeybindingsManager.create(),
  };
  return services;
}
```

### 4.11 CLI 层全局数据流总结

```
用户输入 (CLI args / stdin pipe / TTY)
    │
    ▼
main.ts
    │ parseArgs → createSessionManager → buildSessionOptions
    │ createAgentSessionRuntime → resolveModelScope → createAgentSessionFromServices
    ▼
AgentSessionRuntime
    │ AgentSession (持有 Agent + AgentHarness)
    │ ExtensionRunner (事件路由)
    ▼
运行模式
    │
    ├─ InteractiveMode ─── TUI 渲染 ↔ Agent 事件
    │       │ Editor ←→ streamSimple() → Extension UI
    │       └─ Keybinding / SlashCommand / Selection Dialog
    │
    ├─ PrintMode ─── stdout 输出 final message / JSON events
    │       Agent.prompt() → await → output
    │
    └─ RPCMode ─── stdin JSON命令 → stdout JSON响应+事件
            Agent 命令 → 事件流 → 序列化
            Extension UI 请求 → 转发给 RPC 客户端
```

CLI 层的核心设计原则：**AgentSession 是共享会话抽象，运行模式只提供各自的 I/O 层**。所有模式共享 Agent 生命周期管理、工具执行、会话持久化，但输出方式和交互机制因模式而异。

---

## 5. 关键设计模式总结

### 5.1 三层抽象

```
API 协议层 (anthropic-messages, openai-completions, ...)
    ↓ 映射
Provider 实现层 (Anthropic SDK, OpenAI SDK, Google SDK, ...)
    ↓ 注册
API 注册中心 (api-registry.ts)
    ↓ 路由
统一调用接口 (stream(), complete())
```

### 5.2 Push/Pull 混合的事件流

`AssistantMessageEventStream` 既可以被 `for await...of` 消费（pull），也可以通过 `push()` 从 Provider SDK 接收数据（push）。生产者和消费者完全解耦。

### 5.3 Agent 循环的消息队列

`steer` 和 `followUp` 两个优先级的队列实现了 "在运行中注入消息" 的能力：

- steer → 在当前回合**后**、下回合**前**注入
- followUp → 在 Agent **将要停止时**注入

加上 `QueueMode` ("all" / "one-at-a-time") 控制注入速率。

### 5.4 懒加载 Provider

所有 Provider 模块在首次调用时才动态导入 (`import()`)，避免启动时加载 `anthropic`、`openai`、`@google-ai/generativelanguage` 等 SDK。

### 5.5 Hook 事件体系

AgentHarness 的事件机制允许应用层拦截和修改 Agent 行为，而无需子类化：

```typescript
harness.on("before_provider_request", handler);
harness.on("tool_call", handler);
// 等 20+ 个事件点
```

### 5.6 模型注册表 + 自动化

50+ Provider、数百个模型的注册表自动生成（`generate-models.ts`），每个模型包含定价、上下文窗口、思考级别映射等元数据。

### 5.7 Session + Compaction

Agent 会话持久化为 JSONL，支持分支、恢复。Compaction 机制在上下文将满时自动压缩早期消息为摘要，使长对话可持续。

### 5.8 完整的 AgentMessage 桥接模式

Agent 层通过 `AgentMessage`（联合类型）扩展 LLM 协议消息，通过 `convertToLlm()` 函数在送入 LLM 前动态转换。这使得 bash 执行结果、分支摘要、压缩摘要等非标准消息都能被 LLM 理解，而无需修改 LLM 协议本身。

---

## 6. 编排层次全景图

```
用户输入
    │
    ▼
pi-coding-agent (CLI)
    │ parseArgs → resolveModelScope → createAgentSession
    ▼
AgentHarness (高层封装)
    │ Session 持久化 → 20+ Hook 事件 → Compaction → Branch Summary
    │ Skills/PromptTemplates 注入 → Tool 注册 → streaming 管线
    ▼
Agent (状态管理 + 队列)
    │ steer/followUp 队列 → convertToLlm → transformContext
    ▼
runAgentLoop (核心循环)
    │ ┌───────────────────────────────────────────┐
    │ │ 外层 (follow-up 消息检查)                  │
    │ │   ┌───────────────────────────────────┐   │
    │ │   │ 内层 (工具 + steering)             │   │
    │ │   │  streamAssistantResponse()         │   │
    │ │   │    transformContext → convertToLlm │   │
    │ │   │    → streamSimple → 流式事件       │   │
    │ │   │  executeToolCalls()                │   │
    │ │   │    prepareToolCall (验证 + before)  │   │
    │ │   │    executePreparedToolCall (并行)    │   │
    │ │   │    finalizeExecutedToolCall (after) │   │
    │ │   │  → prepareNextTurn / stopAfterTurn  │   │
    │ │   │  → steering 消息检查 → 继续/退出    │   │
    │ │   └───────────────────────────────────┘   │
    │ │   → follow-up 消息检查 → 继续/退出        │
    │ └───────────────────────────────────────────┘
    ▼
streamSimple (调用 pi-ai)
    │ api-registry 路由 → Provider 实现 → SDK 调用
    ▼
AssistantMessageEventStream (事件流)
    │ text / thinking / toolcall 分块事件
    ▼
Provider SDK → LLM API (Anthropic / OpenAI / Google / ...)
```

---

本文档详细覆盖了 pi 框架的 Agent 层运行时机制，从 `Agent.prompt()` 入口到 `runAgentLoop()` 双层循环，到 `streamAssistantResponse()` 的 LLM 调用，再到 `executeToolCalls()` 的工具执行生命周期，最后到 `AgentHarness` 的生产级特性。如需进一步了解某个具体子系统（如 Compaction 算法细节、Session 分支管理、TUI 差分渲染机制），可在阅读对应源码后补充。