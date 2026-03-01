import { exec, execOrThrow } from "./shell.js";

/**
 * Check that `gh` CLI is installed and authenticated.
 * Returns the authenticated username.
 */
export async function ensureGhAuth(): Promise<string> {
	const result = await exec("gh", ["auth", "status"]);
	if (result.exitCode !== 0) {
		throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
	}

	// Get the username
	const username = await execOrThrow("gh", ["api", "user", "--jq", ".login"]);
	return username;
}

/**
 * Detect repo owner/name from git remote.
 * Falls back to null if it can't be determined.
 */
export async function detectRepo(): Promise<{ owner: string; name: string } | null> {
	const result = await exec("gh", ["repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name']);
	if (result.exitCode !== 0 || !result.stdout.includes("/")) {
		return null;
	}
	const [owner, name] = result.stdout.split("/");
	return { owner, name };
}

/**
 * Create a GitHub environment via REST API.
 * Idempotent — if the environment already exists, this is a no-op.
 */
export async function createEnvironment(owner: string, repo: string, environment: string): Promise<boolean> {
	// PUT is idempotent — creates if missing, no-op if exists
	const result = await exec("gh", ["api", "--method", "PUT", `repos/${owner}/${repo}/environments/${environment}`, "--silent"]);
	return result.exitCode === 0;
}

/**
 * Set an environment secret. Overwrites if already set.
 */
export async function setSecret(repo: string, environment: string, name: string, value: string): Promise<void> {
	await execOrThrow("gh", ["secret", "set", name, "--env", environment, "--body", value, "-R", repo]);
}

/**
 * Set a repository-level secret (not scoped to an environment). Overwrites if already set.
 */
export async function setRepoSecret(repo: string, name: string, value: string): Promise<void> {
	await execOrThrow("gh", ["secret", "set", name, "--body", value, "-R", repo]);
}

/**
 * Set an environment variable. Overwrites if already set.
 */
export async function setVariable(repo: string, environment: string, name: string, value: string): Promise<void> {
	// gh variable set overwrites if the variable already exists
	await execOrThrow("gh", ["variable", "set", name, "--env", environment, "--body", value, "-R", repo]);
}

/**
 * Trigger a workflow dispatch event.
 */
export async function triggerWorkflow(repo: string, workflow: string, inputs?: Record<string, string>): Promise<void> {
	const args = ["workflow", "run", workflow, "-R", repo];
	if (inputs) {
		for (const [key, value] of Object.entries(inputs)) {
			args.push("-f", `${key}=${value}`);
		}
	}
	await execOrThrow("gh", args);
}
