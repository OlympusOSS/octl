import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { commandExists, exec } from "../lib/shell.js";
import * as ui from "../lib/ui.js";

/** Dev service URLs shown at the end. */
const DEV_SERVICES = [
	{ name: "Site", url: "http://localhost:2000" },
	{ name: "CIAM Hera (login)", url: "http://localhost:3001" },
	{ name: "IAM Hera (login)", url: "http://localhost:4001" },
	{ name: "CIAM Athena (admin)", url: "http://localhost:3003" },
	{ name: "IAM Athena (admin)", url: "http://localhost:4003" },
	{ name: "pgAdmin", url: "http://localhost:4000" },
	{ name: "Mailslurper", url: "http://localhost:4436" },
];

/** Health endpoints to poll after docker compose up. */
const HEALTH_ENDPOINTS = [
	{ name: "IAM Kratos", url: "http://localhost:4101/health/ready" },
	{ name: "CIAM Kratos", url: "http://localhost:3101/health/ready" },
	{ name: "IAM Hydra", url: "http://localhost:4103/health/ready" },
	{ name: "CIAM Hydra", url: "http://localhost:3103/health/ready" },
];

/**
 * Resolve the platform/dev directory by walking up from the current
 * working directory looking for the Olympus workspace root.
 */
function findPlatformDevDir(): string {
	// Try common locations relative to the octl package
	const candidates = [
		resolve(process.cwd(), "../platform/dev"),
		resolve(process.cwd(), "platform/dev"),
		resolve(import.meta.dirname, "../../../platform/dev"),
	];

	for (const dir of candidates) {
		if (existsSync(resolve(dir, "docker-compose.yml"))) {
			return dir;
		}
	}

	throw new Error("Could not find platform/dev/docker-compose.yml. " + "Run octl from the Olympus workspace root or the octl/ directory.");
}

async function checkDocker(): Promise<boolean> {
	const available = await commandExists("docker");
	if (!available) {
		ui.error("Docker is not installed.");
		if (process.platform === "darwin") {
			ui.info(`Install with: ${ui.cmd("brew install --cask docker")}`);
		} else {
			ui.info(`Install from: ${ui.url("https://docs.docker.com/engine/install/")}`);
		}
		return false;
	}

	// Verify Docker daemon is running
	const result = await exec("docker", ["info"]);
	if (result.exitCode !== 0) {
		ui.error("Docker is installed but the daemon is not running.");
		ui.info(`Start Docker Desktop or run: ${ui.cmd("sudo systemctl start docker")}`);
		return false;
	}

	ui.success("Docker is installed and running");
	return true;
}

async function checkDockerCompose(): Promise<boolean> {
	const result = await exec("docker", ["compose", "version"]);
	if (result.exitCode !== 0) {
		ui.error("Docker Compose V2 is not available.");
		ui.info(`It comes with Docker Desktop, or install: ${ui.cmd("apt install docker-compose-plugin")}`);
		return false;
	}
	ui.success(`Docker Compose found: ${ui.dim(result.stdout.split("\n")[0])}`);
	return true;
}

async function checkNode(): Promise<boolean> {
	const available = await commandExists("node");
	if (!available) {
		ui.error("Node.js is not installed.");
		ui.info(`Install with: ${ui.cmd("nvm install 20")} or from ${ui.url("https://nodejs.org")}`);
		return false;
	}

	const result = await exec("node", ["--version"]);
	const version = result.stdout.replace("v", "");
	const major = Number.parseInt(version.split(".")[0], 10);

	if (major < 20) {
		ui.warn(`Node.js ${version} found — version 20+ is recommended.`);
		ui.info(`Upgrade with: ${ui.cmd("nvm install 20")}`);
		return true; // non-fatal
	}

	ui.success(`Node.js ${ui.dim(result.stdout)} found`);
	return true;
}

async function checkNpm(): Promise<boolean> {
	const available = await commandExists("npm");
	if (!available) {
		ui.error("npm is not installed.");
		ui.info("It comes with Node.js — install Node first.");
		return false;
	}
	const result = await exec("npm", ["--version"]);
	ui.success(`npm ${ui.dim(`v${result.stdout}`)} found`);
	return true;
}

async function waitForHealth(maxRetries = 30, intervalMs = 2000): Promise<boolean> {
	for (let i = 1; i <= maxRetries; i++) {
		let allHealthy = true;

		for (const endpoint of HEALTH_ENDPOINTS) {
			try {
				const res = await fetch(endpoint.url);
				if (!res.ok) allHealthy = false;
			} catch {
				allHealthy = false;
			}
		}

		if (allHealthy) {
			for (const endpoint of HEALTH_ENDPOINTS) {
				ui.success(`${endpoint.name} is ready`);
			}
			return true;
		}

		if (i % 5 === 0) {
			ui.info(`Waiting for services... (${i}/${maxRetries})`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Report which services are still not ready
	for (const endpoint of HEALTH_ENDPOINTS) {
		try {
			const res = await fetch(endpoint.url);
			if (res.ok) {
				ui.success(`${endpoint.name} is ready`);
			} else {
				ui.error(`${endpoint.name} is NOT ready (status ${res.status})`);
			}
		} catch {
			ui.error(`${endpoint.name} is NOT reachable`);
		}
	}
	return false;
}

/**
 * Dev command — check prerequisites, bootstrap dev stack, verify health.
 */
export async function run(): Promise<void> {
	console.log("");
	ui.info(ui.bold("Checking prerequisites..."));
	console.log("");

	// ── Prerequisites ─────────────────────────────────────────
	const dockerOk = await checkDocker();
	if (!dockerOk) {
		ui.error("Fix Docker installation before continuing.");
		process.exit(1);
	}

	const composeOk = await checkDockerCompose();
	if (!composeOk) {
		ui.error("Fix Docker Compose before continuing.");
		process.exit(1);
	}

	const nodeOk = await checkNode();
	const npmOk = await checkNpm();

	if (!nodeOk || !npmOk) {
		ui.warn("Node.js/npm issues detected — some local dev features may not work.");
	}

	console.log("");

	// ── Bootstrap dev stack ───────────────────────────────────
	const devDir = findPlatformDevDir();
	ui.info(`Found platform/dev at: ${ui.cmd(devDir)}`);
	ui.info(`Starting dev stack with ${ui.cmd("docker compose up -d")}...`);
	console.log("");

	const upResult = await exec("docker", ["compose", "up", "-d"], { timeout: 120_000 });
	if (upResult.exitCode !== 0) {
		ui.error("docker compose up failed:");
		console.log(upResult.stderr || upResult.stdout);
		process.exit(1);
	}
	if (upResult.stdout) console.log(upResult.stdout);
	ui.success("Docker Compose started");
	console.log("");

	// ── Wait for services ─────────────────────────────────────
	ui.info("Waiting for services to become healthy...");
	const healthy = await waitForHealth();

	if (!healthy) {
		ui.warn("Some services are not ready yet. They may still be starting.");
		ui.info(`Check logs with: ${ui.cmd("docker compose logs -f <service>")}`);
	}
	console.log("");

	// ── Verify seed ───────────────────────────────────────────
	ui.info("Checking seed status...");
	const seedLogs = await exec("docker", ["compose", "logs", "athena-seed-dev"]);
	const seedComplete = seedLogs.stdout.includes("Seed complete!");

	if (seedComplete) {
		ui.success("Seed completed successfully");
	} else {
		ui.warn("Seed may not have completed yet.");
		const rerun = await confirm({
			message: "Re-run the seed script?",
			default: true,
		});
		if (rerun) {
			ui.info("Re-running seed...");
			await exec("docker", ["compose", "restart", "athena-seed-dev"], { timeout: 60_000 });
			// Wait a bit for the seed to complete
			await new Promise((r) => setTimeout(r, 10_000));
			const retryLogs = await exec("docker", ["compose", "logs", "--tail", "20", "athena-seed-dev"]);
			if (retryLogs.stdout.includes("Seed complete!")) {
				ui.success("Seed completed successfully");
			} else {
				ui.warn(`Seed may still be running. Check: ${ui.cmd("docker compose logs -f athena-seed-dev")}`);
			}
		}
	}

	// ── Summary ───────────────────────────────────────────────
	ui.summaryBox("Dev Environment Ready");

	ui.info(ui.bold("Services:"));
	for (const svc of DEV_SERVICES) {
		ui.keyValue(svc.name, ui.url(svc.url));
	}
	console.log("");

	ui.info(ui.bold("Test credentials:"));
	ui.keyValue("Admin", `${ui.label("admin@demo.user")} ${ui.dim("/")} ${ui.magenta("admin123!")}`);
	ui.keyValue("Viewer", `${ui.label("viewer@demo.user")} ${ui.dim("/")} ${ui.magenta("admin123!")}`);
	ui.keyValue("Customer", `${ui.label("demo@demo.user")} ${ui.dim("/")} ${ui.magenta("admin123!")}`);
	console.log("");
}
