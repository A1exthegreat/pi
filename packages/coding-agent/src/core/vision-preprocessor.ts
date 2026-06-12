import {
	type Api,
	type Context,
	completeSimple,
	type ImageContent,
	type Message,
	type Model,
	shortHash,
	type TextContent,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "./model-registry.ts";
import type { SettingsManager } from "./settings-manager.ts";

const VISION_SYSTEM_PROMPT = `You are an image description assistant for a coding agent. Describe the image concisely and accurately, focusing on:
- Text content (code, error messages, UI labels, file paths) -- transcribe verbatim
- Layout and structure (diagrams, screenshots, UI layouts)
- Relevant visual details (colors, highlights, annotations)

Be precise and technical. Output only the description, no preamble.`;

const MAX_CACHE_SIZE = 100;

export class VisionDescriptionCache {
	private cache = new Map<string, string>();

	get(imageData: string): string | undefined {
		return this.cache.get(shortHash(imageData));
	}

	set(imageData: string, description: string): void {
		if (this.cache.size >= MAX_CACHE_SIZE) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(shortHash(imageData), description);
	}

	get size(): number {
		return this.cache.size;
	}
}

interface ImageLocation {
	messageIndex: number;
	contentIndex: number;
	image: ImageContent;
	hash: string;
	cachedDescription?: string;
}

export interface VisionPreprocessOptions {
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	cache: VisionDescriptionCache;
	signal?: AbortSignal;
}

export interface VisionPreprocessResult {
	context: Context;
	descriptionsGenerated: number;
	errors: string[];
}

function collectImageLocations(messages: Message[], cache: VisionDescriptionCache): ImageLocation[] {
	const locations: ImageLocation[] = [];
	for (let mi = 0; mi < messages.length; mi++) {
		const msg = messages[mi];
		if (msg.role !== "user" && msg.role !== "toolResult") continue;
		if (typeof msg.content === "string") continue;
		for (let ci = 0; ci < msg.content.length; ci++) {
			const block = msg.content[ci];
			if (block.type !== "image") continue;
			const hash = shortHash(block.data);
			locations.push({
				messageIndex: mi,
				contentIndex: ci,
				image: block,
				hash,
				cachedDescription: cache.get(block.data),
			});
		}
	}
	return locations;
}

async function describeImage(
	image: ImageContent,
	visionModel: Model<Api>,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const result = await completeSimple(
		visionModel,
		{
			systemPrompt: VISION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Describe this image:" }, image],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			headers,
			signal,
			maxTokens: 1024,
		},
	);

	const textBlock = result.content.find((b): b is TextContent => b.type === "text");
	if (!textBlock?.text) {
		throw new Error("Vision model returned no text content");
	}
	return textBlock.text.trim();
}

export async function preprocessVision(
	mainModel: Model<Api>,
	context: Context,
	options: VisionPreprocessOptions,
): Promise<VisionPreprocessResult> {
	if (mainModel.input.includes("image")) {
		return { context, descriptionsGenerated: 0, errors: [] };
	}

	const visionSettings = options.settingsManager.getVisionModel();
	if (!visionSettings?.provider || !visionSettings?.modelId) {
		return { context, descriptionsGenerated: 0, errors: [] };
	}

	const locations = collectImageLocations(context.messages, options.cache);
	if (locations.length === 0) {
		return { context, descriptionsGenerated: 0, errors: [] };
	}

	const visionModel = options.modelRegistry.find(visionSettings.provider, visionSettings.modelId);
	if (!visionModel) {
		return { context, descriptionsGenerated: 0, errors: [] };
	}

	const auth = await options.modelRegistry.getApiKeyAndHeaders(visionModel);
	if (!auth.ok) {
		return { context, descriptionsGenerated: 0, errors: [] };
	}

	const uncached = locations.filter((loc) => !loc.cachedDescription);

	let results: PromiseSettledResult<string>[] = [];
	if (uncached.length > 0) {
		results = await Promise.allSettled(
			uncached.map((loc) => describeImage(loc.image, visionModel, auth.apiKey, auth.headers, options.signal)),
		);
	}

	const messages = [...context.messages];

	let descriptionsGenerated = 0;
	const errors: string[] = [];

	for (const loc of locations) {
		let replacementText: string;
		if (loc.cachedDescription) {
			replacementText = loc.cachedDescription;
		} else {
			const uncachedIndex = uncached.indexOf(loc);
			const result = results[uncachedIndex];
			if (result.status === "fulfilled") {
				replacementText = result.value;
				options.cache.set(loc.image.data, replacementText);
				descriptionsGenerated++;
			} else {
				const errMsg = result.reason instanceof Error ? result.reason.message : "unknown error";
				replacementText = `(image description failed: ${errMsg})`;
				errors.push(`${loc.hash}: ${errMsg}`);
			}
		}

		const msg = messages[loc.messageIndex];
		if ((msg.role === "user" || msg.role === "toolResult") && Array.isArray(msg.content)) {
			const newContent = [...msg.content];
			newContent[loc.contentIndex] = { type: "text", text: `[Image description: ${replacementText}]` };
			messages[loc.messageIndex] = { ...msg, content: newContent } as Message;
		}
	}

	return {
		context: { ...context, messages },
		descriptionsGenerated,
		errors,
	};
}
