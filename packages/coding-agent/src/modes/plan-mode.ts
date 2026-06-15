/**
 * Plan mode: Plan first, then execute step by step with checkpoints and commits.
 *
 * Usage:
 *   pi --mode plan "Refactor the agent module to use interfaces"
 *   pi -p "task"          # (regular print mode, unchanged)
 *   pi --mode plan -p "task"
 *
 * Workflow:
 * 1. Send task to LLM with a plan-creating system prompt.
 * 2. Display the generated plan.
 * 3. Ask user for confirmation to proceed.
 * 4. Execute each step sequentially: prompt -> check -> commit.
 * 5. After all steps complete, report summary.
 */

import { createInterface } from "node:readline";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Options for plan mode.
 */
export interface PlanModeOptions {
	/** The high-level task description */
	task: string;
	/** Images to attach (optional) */
	initialImages?: ImageContent[];
	/** Additional messages to send after the task */
	messages?: string[];
	/** Custom check command (default: "npm run check") */
	checkCommand?: string;
	/** Whether to skip user confirmation and execute immediately */
	yes?: boolean;
}

/**
 * System prompt added to guide the LLM in creating a plan.
 */
const PLAN_SYSTEM_PROMPT = `You are a planning assistant. Your task is to create a clear, step-by-step plan for implementing the user's request.

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
 * Guides the LLM to be focused and to commit changes.
 */
const EXECUTE_STEP_PROMPT = `Execute this step. After making changes, run the check command. If the check passes, stage all changes and commit with a descriptive message. If the check fails, fix the issues and try again.`;

/**
 * Parse the plan from the LLM response text.
 * Returns an array of step titles/descriptions.
 */
export function parsePlanSteps(text: string): string[] {
	const steps: string[] = [];
	// Match numbered steps: "1. **Title** - Description" or "1. Title"
	const stepRegex = /^\d+\.\s+(?:\*\*)?([^*\n]+)(?:\*\*)?(?:\s*[-–—]\s*(.+))?$/gm;
	let match = stepRegex.exec(text);
	while (match !== null) {
		const title = (match[1] ?? "").trim();
		const description = (match[2] ?? "").trim();
		const stepText = description ? `${title}: ${description}` : title;
		if (title) {
			steps.push(stepText);
		}
		match = stepRegex.exec(text);
	}

	// Fallback: if no numbered steps found, treat lines between ## Plan and next ## as plan text
	if (steps.length === 0) {
		const planSection = text.match(/##\s*Plan\s*\n([\s\S]*?)(?=\n##|$)/);
		if (planSection) {
			const lines = planSection[1]
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));
			for (const line of lines) {
				// Remove leading numbers/bullets
				const clean = line.replace(/^[\d*.•-]+\s*/, "").trim();
				if (clean) steps.push(clean);
			}
		}
	}

	return steps;
}

/**
 * Ask the user a yes/no question via stdin.
 * Returns true for yes, false for no.
 */
async function askConfirmation(question: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`${question} [Y/n] `, (answer) => {
			rl.close();
			const trimmed = answer.trim().toLowerCase();
			resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
		});
	});
}

/**
 * Run in plan mode.
 */
export async function runPlanMode(runtimeHost: AgentSessionRuntime, options: PlanModeOptions): Promise<number> {
	const { task, messages = [], checkCommand = "npm run check", yes = false, initialImages } = options;
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
		console.log("\n=== PLAN MODE ===");
		console.log(`Task: ${task}`);
		console.log("Generating plan...\n");

		// Save original system prompt
		const originalSystemPrompt = (session as any).agent.state.systemPrompt;

		// Set system prompt for planning
		(session as any).agent.state.systemPrompt = PLAN_SYSTEM_PROMPT;

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

		// Phase 2: Confirmation
		const confirmed = yes || (await askConfirmation("\nProceed with this plan?"));
		if (!confirmed) {
			console.log("Plan cancelled by user.");
			return 0;
		}

		// Phase 3: Execute each step
		console.log("\n=== EXECUTING PLAN ===\n");

		// Reset system prompt for execution
		(session as any).agent.state.systemPrompt = originalSystemPrompt;

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const stepNum = i + 1;
			console.log(`\n--- Step ${stepNum}/${steps.length}: ${step} ---\n`);

			// Execute this step
			const stepPrompt = `Step ${stepNum}/${steps.length}: ${step}\n\n${EXECUTE_STEP_PROMPT}\n\nCheck command: ${checkCommand}`;
			await session.prompt(stepPrompt);
			await session.agent.waitForIdle();

			// Check if the step resulted in an error
			const lastMsg = session.state.messages[session.state.messages.length - 1];
			if (lastMsg?.role === "assistant" && "stopReason" in lastMsg) {
				const assistantMsg = lastMsg as any;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(`\nStep ${stepNum} failed: ${assistantMsg.errorMessage || "Unknown error"}`);
					console.error("Continuing to next step...");
					exitCode = 1;
				}
			}

			console.log(`\n--- Step ${stepNum} complete ---`);
		}

		// Send any additional messages
		for (const message of messages) {
			await session.prompt(message);
			await session.agent.waitForIdle();
		}

		console.log("\n=== PLAN COMPLETE ===\n");

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
