import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
const originalOpencodeApiKey = process.env.OPENCODE_API_KEY;

afterEach(() => {
	if (originalDeepseekApiKey === undefined) {
		delete process.env.DEEPSEEK_API_KEY;
	} else {
		process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
	}

	if (originalOpencodeApiKey === undefined) {
		delete process.env.OPENCODE_API_KEY;
	} else {
		process.env.OPENCODE_API_KEY = originalOpencodeApiKey;
	}
});

describe("environment API keys", () => {
	it("resolves DeepSeek credentials from DEEPSEEK_API_KEY", () => {
		process.env.DEEPSEEK_API_KEY = "deepseek-token";

		expect(findEnvKeys("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
		expect(getEnvApiKey("deepseek")).toBe("deepseek-token");
	});

	it("resolves OpenCode Zen credentials from OPENCODE_API_KEY", () => {
		process.env.OPENCODE_API_KEY = "opencode-token";

		expect(findEnvKeys("opencode")).toEqual(["OPENCODE_API_KEY"]);
		expect(getEnvApiKey("opencode")).toBe("opencode-token");
	});

	it("resolves OpenCode Go credentials from OPENCODE_API_KEY", () => {
		process.env.OPENCODE_API_KEY = "opencode-token";

		expect(findEnvKeys("opencode-go")).toEqual(["OPENCODE_API_KEY"]);
		expect(getEnvApiKey("opencode-go")).toBe("opencode-token");
	});

	it("returns undefined for unknown providers", () => {
		expect(findEnvKeys("unknown-provider")).toBeUndefined();
		expect(getEnvApiKey("unknown-provider")).toBeUndefined();
	});
});
