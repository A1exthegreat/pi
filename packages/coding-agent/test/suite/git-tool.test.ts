/**
 * Tests for the git tool.
 *
 * Creates temp git repositories and tests basic git operations:
 * init, status, add, commit, log, diff.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitTool } from "../../src/core/tools/git.ts";

function createTempGitRepo(): { dir: string; cleanup: () => void } {
	const dir = join(tmpdir(), `pi-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	// Initialize git repo
	execSync("git init", { cwd: dir });
	execSync('git config user.email "test@test.com"', { cwd: dir });
	execSync('git config user.name "Test"', { cwd: dir });
	return {
		dir,
		cleanup: () => {
			try {
				execSync("rm -rf", { cwd: dir, input: dir });
			} catch {
				// best effort cleanup
			}
		},
	};
}

describe("git tool", () => {
	const repos: Array<{ dir: string; cleanup: () => void }> = [];

	afterEach(() => {
		while (repos.length > 0) {
			repos.pop()?.cleanup();
		}
	});

	it("status shows clean repo after init", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);

		const tool = createGitTool(repo.dir);
		const result = await tool.execute("call-1", { command: "status" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("nothing to commit");
	});

	it("status shows untracked file", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);
		writeFileSync(join(repo.dir, "test.txt"), "hello");

		const tool = createGitTool(repo.dir);
		const result = await tool.execute("call-1", { command: "status" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("test.txt");
	});

	it("add and commit", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);
		writeFileSync(join(repo.dir, "test.txt"), "hello");

		const tool = createGitTool(repo.dir);

		// Add
		const addResult = await tool.execute("call-1", { command: "add test.txt" });
		expect(addResult.content.find((c) => c.type === "text")?.text).toBeDefined();

		// Commit
		const commitResult = await tool.execute("call-2", {
			command: 'commit -m "Initial commit"',
		});
		const commitText = commitResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(commitText).toContain("1 file changed");
	});

	it("log shows commit history", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);

		// Create and commit a file
		writeFileSync(join(repo.dir, "a.txt"), "a");
		execSync("git add a.txt", { cwd: repo.dir });
		execSync('git commit -m "First commit"', { cwd: repo.dir });
		writeFileSync(join(repo.dir, "b.txt"), "b");
		execSync("git add b.txt", { cwd: repo.dir });
		execSync('git commit -m "Second commit"', { cwd: repo.dir });

		const tool = createGitTool(repo.dir);
		const result = await tool.execute("call-1", { command: "log --oneline" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("Second commit");
		expect(text).toContain("First commit");
	});

	it("diff shows changes", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);
		writeFileSync(join(repo.dir, "test.txt"), "world");
		execSync("git add test.txt", { cwd: repo.dir });
		execSync('git commit -m "Initial"', { cwd: repo.dir });
		writeFileSync(join(repo.dir, "test.txt"), "hello\nworld");

		const tool = createGitTool(repo.dir);
		const result = await tool.execute("call-1", { command: "diff" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("+hello");
	});

	it("diff shows additions", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);
		writeFileSync(join(repo.dir, "test.txt"), "hello\nworld");
		execSync("git add test.txt", { cwd: repo.dir });
		execSync('git commit -m "Initial"', { cwd: repo.dir });
		writeFileSync(join(repo.dir, "test.txt"), "hello\nchanged\nworld");

		const tool = createGitTool(repo.dir);
		const result = await tool.execute("call-1", { command: "diff" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("+changed");
	});

	it("branch operations", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);
		writeFileSync(join(repo.dir, "test.txt"), "hello");
		execSync("git add test.txt", { cwd: repo.dir });
		execSync('git commit -m "Initial"', { cwd: repo.dir });

		const tool = createGitTool(repo.dir);

		// Create branch
		await tool.execute("call-1", { command: "branch feature" });

		// List branches
		const listResult = await tool.execute("call-2", { command: "branch" });
		const listText = listResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(listText).toContain("feature");
		expect(listText).toContain("master");
	});

	it("throws on non-git directory", async () => {
		const dir = join(tmpdir(), `pi-non-git-${Date.now()}`);
		mkdirSync(dir, { recursive: true });

		const tool = createGitTool(dir);
		await expect(tool.execute("call-1", { command: "status" })).rejects.toThrow();

		try {
			execSync("rm -rf", { cwd: dir, input: dir });
		} catch {
			// best effort
		}
	});

	it("stash operations", async () => {
		const repo = createTempGitRepo();
		repos.push(repo);
		writeFileSync(join(repo.dir, "test.txt"), "hello");
		execSync("git add test.txt", { cwd: repo.dir });
		execSync('git commit -m "Initial"', { cwd: repo.dir });

		// Make uncommitted change
		writeFileSync(join(repo.dir, "test.txt"), "modified");

		const tool = createGitTool(repo.dir);

		// Stash
		await tool.execute("call-1", { command: "stash" });

		// Verify working directory is clean
		const statusResult = await tool.execute("call-2", { command: "status" });
		const statusText = statusResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(statusText).toContain("nothing to commit");

		// Pop stash
		await tool.execute("call-3", { command: "stash pop" });

		const statusResult2 = await tool.execute("call-4", { command: "status" });
		const statusText2 = statusResult2.content.find((c) => c.type === "text")?.text ?? "";
		expect(statusText2).toContain("Changes not staged for commit");
	});
});
