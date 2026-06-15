/**
 * Task mode: Autonomous task execution without confirmation prompts.
 *
 * Workflow (reuses plan mode's parsePlanSteps and execution flow):
 * 1. Send task to LLM with a plan-creating system prompt.
 * 2. Parse the generated plan.
 * 3. Automatically execute each step sequentially:
 *    a. Prompt the agent to execute the step with a check-guidance system prompt.
 *    b. On check failure, retry up to a configurable max.
 *    c. If check passes, auto-commit changes.
 *    d. Continue to the next step.
 * 4. After all steps complete, generate a summary.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { parsePlanSteps } from "./plan-mode.ts";

/**
 * Options for task mode.
 */
export interface TaskModeOptions {
	/** The high-level task description */
	task: string;
	/** Images to attach (optional) */
	initialImages?: ImageContent[];
	/** Additional messages to send after the task */
	messages?: string[];
	/** Custom check command (default: "npm run check") */
	checkCommand?: string;
	/** Max retries per step on check failures (default: 2) */
	maxRetries?: number;
}

/**
 * System prompt added to guide the LLM in creating a plan.
 */
const TASK_PLAN_SYSTEM_PROMPT = `You are a planning assistant. Your task is to create a clear, step-by-step plan for implementing the user's request.

Analyze the request and produce a numbered list of steps. Each step should be:
- Concrete and actionable (e.g., "Create file X with Y interface", "Refactor Z to use the new interface", "Update tests for Z")
- Ordered logically (dependencies first)
- Sized so each step can be implemented in a single agent turn

After listing the steps, briefly note any risks or dependencies.

Format your response as follows (use plain text, no markdown code fences):

## Plan

1. **Step 1 title** - Description of what to do
2. **Step 2 title** - Description of what to do
...

## Risks
- Risk 1
- Risk 2

Do NOT execute the plan. Only describe the steps.`;

/**
 * System prompt appended when executing each step.
 * Guides the LLM to be focused, run checks, and commit changes.
 */
const TASK_EXECUTE_STEP_PROMPT = `Execute this step autonomously. After making changes, run the check command to verify correctness.
If the check passes, stage all changes and commit with a descriptive message mentioning the step number.
If the check fails, fix the issues and re-run the check until it passes.
Do NOT ask for confirmation. Just proceed and report what you did.`;

/**
 * System prompt for the summary phase after all steps complete.
 */
const TASK_SUMMARY_SYSTEM_PROMPT = `Provide a concise summary of what has been accomplished. Mention each step and the key changes made.`;

/**
 * Parse the plan from the LLM response text.
 * Returns an array of step titles/descriptions.
 */
/**
 * Ask the user a yes/no question via stdin.
 * Returns true for yes, false for no.
 */
/**
 * Run in auto task mode.
 */
export async function runTaskMode(runtimeHost: AgentSessionRuntime, options: TaskModeOptions): Promise<number> {
	const { task, messages = [], checkCommand = "npm run check", maxRetries = 2, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
	};

	const getLastAssistantText = (): string => {
		const state = session.state;
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const msg = state.messages[i];
			if (msg.role === "assistant") {
				return msg.content
					.filter(
						(c): c is { type: "text"; text: string } =>
							c.type === "text" && Boolean((c as { text?: string }).text),
					)
					.map((c) => c.text)
					.join("\n");
			}
		}
		return "";
	};

	try {
		await rebindSession();

		// Phase 1: Generate plan
		console.log("\n=== TASK MODE ===");
		console.log(`Task: ${task}`);
		console.log("Generating plan...\n");

		// Set system prompt for planning
		(session as any).agent.state.systemPrompt = TASK_PLAN_SYSTEM_PROMPT;

		await session.prompt(task, { images: initialImages });
		await session.agent.waitForIdle();

		const planResponse = getLastAssistantText();
		console.log(`\n${planResponse}\n`);

		// Parse steps
		const steps = parsePlanSteps(planResponse);
		if (steps.length === 0) {
			console.error("Could not parse plan steps from LLM response.");
			console.error("Raw response:");
			console.error(planResponse);
			return 1;
		}

		console.log(`\nDetected ${steps.length} steps:`);
		for (let i = 0; i < steps.length; i++) {
			console.log(`  ${i + 1}. ${steps[i]}`);
		}

		// Phase 2: Automatically execute (no confirmation)
		console.log("\n=== EXECUTING PLAN ===\n");

		// Reset system prompt for execution with autonomous instructions
		(session as any).agent.state.systemPrompt = TASK_EXECUTE_STEP_PROMPT;

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const stepNum = i + 1;
			console.log(`\n--- Step ${stepNum}/${steps.length}: ${step} ---\n`);

			// Execute this step with retries
			let attempt = 0;
			let stepFailed = false;
			while (attempt <= maxRetries) {
				if (attempt > 0) {
					console.log(`\n--- Retry ${attempt}/${maxRetries} for step ${stepNum} ---`);
				}

				const stepPrompt = `Step ${stepNum}/${steps.length}: ${step}\n\n${TASK_EXECUTE_STEP_PROMPT}\n\nCheck command: ${checkCommand}`;
				await session.prompt(stepPrompt);
				await session.agent.waitForIdle();

				// Check if the step resulted in an error
				const lastMsg = session.state.messages[session.state.messages.length - 1];
				if (lastMsg?.role === "assistant" && "stopReason" in lastMsg) {
					const assistantMsg = lastMsg as any;
					if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
						stepFailed = true;
						console.error(
							`\nStep ${stepNum} attempt ${attempt + 1} failed: ${assistantMsg.errorMessage || "Unknown error"}`,
						);
						if (attempt < maxRetries) {
							// Tell the agent about the failure and ask it to fix
							const retryPrompt = `The previous attempt failed with: ${assistantMsg.errorMessage || "Unknown error"}\n\nPlease fix the issue and try again. ${TASK_EXECUTE_STEP_PROMPT}\n\nCheck command: ${checkCommand}`;
							await session.prompt(retryPrompt);
							await session.agent.waitForIdle();
							if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
								// Still failed after retry
							}
						}
						attempt++;
						continue;
					}
				}
				// Success
				stepFailed = false;
				break;
			}

			if (stepFailed) {
				console.error(`\nStep ${stepNum} failed after ${maxRetries + 1} attempts. Continuing to next step...`);
				exitCode = 1;
			} else {
				console.log(`\n--- Step ${stepNum} complete ---`);
			}
		}

		// Phase 3: Summary
		console.log("\n=== GENERATING SUMMARY ===\n");

		// Switch to summary system prompt
		(session as any).agent.state.systemPrompt = TASK_SUMMARY_SYSTEM_PROMPT;

		// Send any additional messages
		for (const message of messages) {
			await session.prompt(message);
			await session.agent.waitForIdle();
		}

		// Prompt for summary
		await session.prompt("Please provide a summary of what was accomplished in this task.");
		await session.agent.waitForIdle();

		const summaryResponse = getLastAssistantText();
		console.log(`\n${summaryResponse}\n`);

		console.log("\n=== TASK COMPLETE ===\n");

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
