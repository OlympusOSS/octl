import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import { lookupDropletIp } from "../lib/digitalocean.js";
import { commandExists, exec, execOrThrow, installHint } from "../lib/shell.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

const SSH_KEY_NAME = "olympusoss-deploy";
const CLOUD_INIT = `#cloud-config
packages:
  - docker.io
  - docker-compose-plugin
runcmd:
  - systemctl enable --now docker
  - usermod -aG docker root
`;

/**
 * Step 3 — DigitalOcean Droplet: create or connect to a Droplet + set up SSH.
 *
 * - Asks: create new or use existing?
 * - If new: uses doctl to create Droplet with Docker via cloud-init
 * - Generates ed25519 SSH keypair for GitHub Actions deploy
 * - Copies public key to Droplet
 */
export async function run(ctx: SetupContext): Promise<void> {
	// If a previous step (e.g. Hostinger) already resolved the IP, skip straight to SSH setup
	if (ctx.dropletIp) {
		ui.skip(`Droplet already resolved: ${ui.host(ctx.dropletIp)}${ctx.dropletName ? ` (${ui.bold(ctx.dropletName)})` : ""}`);
	} else {
		const mode = await select({
			message: `${ui.cyan("DigitalOcean Droplet")}:`,
			choices: [
				{ name: `${ui.bold("Use existing")} ${ui.dim("— connect to an existing Droplet")}`, value: "existing" },
				{ name: `${ui.bold("Create new")} ${ui.dim("— provision via doctl")}`, value: "new" },
			],
		});

		if (mode === "new") {
			await createDroplet(ctx);
		} else {
			await lookupExistingDroplet(ctx);
		}
	}

	ctx.sshUser = await input({
		message: `${ui.cyan("SSH user")} on the Droplet:`,
		default: ctx.sshUser || "root",
	});

	// Generate SSH keypair for deploy
	await generateSshKey(ctx);

	// Copy public key to Droplet
	await copySshKey(ctx);
}

async function lookupExistingDroplet(ctx: SetupContext): Promise<void> {
	const name = await input({
		message: `${ui.cyan("Droplet name")}:`,
		default: "olympusoss-prod",
	});

	ui.info(`Looking up Droplet ${ui.bold(name)}...`);
	const ip = await lookupDropletIp(ctx.doToken, name);
	ctx.dropletName = name;
	ctx.dropletIp = ip;
	ui.success(`Found Droplet ${ui.bold(name)} at ${ui.host(ip)}`);
}

async function createDroplet(ctx: SetupContext): Promise<void> {
	if (!(await commandExists("doctl"))) {
		throw new Error(`${ui.cmd("doctl")} (DigitalOcean CLI) is required to create a Droplet. Install: ${ui.cmd(installHint("doctl"))}`);
	}

	// Authenticate doctl
	await execOrThrow("doctl", ["auth", "init", "--access-token", ctx.doToken]);
	ui.success("Authenticated with DigitalOcean");

	const name = await input({
		message: `${ui.cyan("Droplet name")}:`,
		default: "olympusoss-prod",
	});

	const region = await input({
		message: `${ui.cyan("Region")} ${ui.dim("(e.g. nyc1, sfo3, ams3)")}:`,
		default: "nyc1",
	});

	const size = await input({
		message: `${ui.cyan("Droplet size")} ${ui.dim("(e.g. s-2vcpu-4gb)")}:`,
		default: "s-2vcpu-4gb",
	});

	ui.info("Creating Droplet (this takes 1-2 minutes)...");

	// Write cloud-init to a platform-safe temp location
	const tmpInit = join(tmpdir(), "olympusoss-cloud-init.yml");
	writeFileSync(tmpInit, CLOUD_INIT);

	const result = await execOrThrow(
		"doctl",
		[
			"compute",
			"droplet",
			"create",
			name,
			"--region",
			region,
			"--image",
			"ubuntu-24-04-x64",
			"--size",
			size,
			"--user-data-file",
			tmpInit,
			"--wait",
			"--format",
			"ID,PublicIPv4",
			"--no-header",
		],
		{ timeout: 180_000 },
	);

	const parts = result.split(/\s+/);
	const ip = parts[1];

	if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
		throw new Error(`Could not parse Droplet IP from doctl output: ${result}`);
	}

	ctx.dropletName = name;
	ctx.dropletIp = ip;
	ui.success(`Droplet created: ${ui.bold(name)} (${ui.host(ip)})`);

	// Wait for SSH to become available
	ui.info("Waiting for SSH to become available...");
	for (let i = 0; i < 30; i++) {
		const ssh = await exec("ssh", ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5", `root@${ip}`, "echo ok"]);
		if (ssh.exitCode === 0) {
			ui.success("SSH is ready");
			return;
		}
		await new Promise((r) => setTimeout(r, 5000));
	}
	ui.warn("SSH not responding yet — it may need a few more minutes for cloud-init to complete");
}

async function generateSshKey(ctx: SetupContext): Promise<void> {
	const sshDir = join(homedir(), ".ssh");
	const keyPath = join(sshDir, SSH_KEY_NAME);

	if (!existsSync(sshDir)) {
		// mode is ignored on Windows but required for Unix
		mkdirSync(sshDir, { recursive: true, ...(process.platform !== "win32" && { mode: 0o700 }) });
	}

	if (existsSync(keyPath)) {
		const reuse = await confirm({
			message: `SSH key ${ui.cmd(keyPath)} already exists. Reuse it?`,
			default: true,
		});
		if (reuse) {
			ctx.sshPrivateKeyPath = keyPath;
			ctx.sshPublicKeyPath = `${keyPath}.pub`;
			ui.skip("Reusing existing SSH key");
			return;
		}
	}

	await execOrThrow("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", "olympusoss-deploy"]);
	ctx.sshPrivateKeyPath = keyPath;
	ctx.sshPublicKeyPath = `${keyPath}.pub`;
	ui.success(`Generated SSH key: ${ui.cmd(keyPath)}`);
}

async function copySshKey(ctx: SetupContext): Promise<void> {
	if (!ctx.sshPublicKeyPath || !ctx.dropletIp) return;

	ui.info(`Copying SSH public key to Droplet ${ui.host(ctx.dropletIp)}...`);

	// ssh-copy-id is not available on Windows; use ssh + cat pipe as a cross-platform fallback
	const hasSshCopyId = await commandExists("ssh-copy-id");

	if (hasSshCopyId) {
		const result = await exec("ssh-copy-id", [
			"-i",
			ctx.sshPublicKeyPath,
			"-o",
			"StrictHostKeyChecking=accept-new",
			`${ctx.sshUser}@${ctx.dropletIp}`,
		]);
		if (result.exitCode === 0) {
			ui.success("SSH key installed on Droplet");
			return;
		}
	}

	// Fallback: read key and pipe it via ssh (works on Windows with OpenSSH)
	const pubKey = readFileSync(ctx.sshPublicKeyPath, "utf-8").trim();
	const sshTarget = `${ctx.sshUser}@${ctx.dropletIp}`;
	const appendCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

	const result = await exec("ssh", ["-o", "StrictHostKeyChecking=accept-new", sshTarget, appendCmd]);

	if (result.exitCode === 0) {
		ui.success("SSH key installed on Droplet");
	} else {
		ui.warn("Could not copy SSH key automatically — you may need to add it manually");
		ui.info(`Public key: ${ui.cmd(ctx.sshPublicKeyPath)}`);
	}
}
