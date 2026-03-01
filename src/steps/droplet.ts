import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import { addSshKey, assignReservedIp, createReservedIp, ensureFirewall, listDroplets, listRegions, listReservedIps, listSizes, lookupDropletIp } from "../lib/digitalocean.js";
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
	// Generate SSH keypair first — needed for both new and existing droplets
	await generateSshKey(ctx);

	// List existing droplets and let user choose or create new
	ui.info("Checking for existing Droplets...");
	const droplets = await listDroplets(ctx.doToken);

	let isNewDroplet = false;
	let dropletId: number | undefined;

	if (droplets.length > 0) {
		const chosen = await select({
			message: `${ui.cyan("DigitalOcean Droplet")}:`,
			choices: [
				...droplets.map((d) => ({
					name: `${ui.bold(d.name)} ${ui.dim(d.ip)}`,
					value: d.name,
				})),
				{
					name: `${ui.bold("Create new")} ${ui.dim("— provision via doctl")}`,
					value: "__new__",
				},
			],
		});

		if (chosen !== "__new__") {
			const d = droplets.find((x) => x.name === chosen)!;
			ctx.dropletName = d.name;
			ctx.dropletIp = d.ip;
			dropletId = d.id;
			ui.success(`Using Droplet ${ui.bold(d.name)} at ${ui.host(d.ip)}`);
		} else {
			isNewDroplet = true;
			dropletId = await createDroplet(ctx);
		}
	} else {
		const mode = await select({
			message: `${ui.cyan("No Droplets found")}:`,
			choices: [
				{ name: `${ui.bold("Create new")} ${ui.dim("— provision via doctl")}`, value: "new" },
				{ name: `${ui.bold("Enter IP manually")} ${ui.dim("— existing server")}`, value: "manual" },
			],
		});

		if (mode === "new") {
			isNewDroplet = true;
			dropletId = await createDroplet(ctx);
		} else {
			ctx.dropletIp = await input({
				message: `${ui.cyan("Server IP address")}:`,
				validate: (v) => (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? true : "Enter a valid IPv4 address"),
			});
			ctx.dropletName = await input({
				message: `${ui.cyan("Server name")} ${ui.dim("(for reference)")}:`,
				default: "olympusoss-prod",
			});
		}
	}

	// Register deploy key with DigitalOcean (idempotent — needed for both new and existing)
	if (ctx.sshPublicKeyPath) {
		ui.info("Registering deploy SSH key with DigitalOcean...");
		const pubKey = readFileSync(ctx.sshPublicKeyPath, "utf-8").trim();
		const keyInfo = await addSshKey(ctx.doToken, SSH_KEY_NAME, pubKey);
		ui.success(`Deploy key registered (${ui.dim(keyInfo.fingerprint)})`);
	}

	// Ensure cloud firewall exists (required for GitHub Actions SSH access)
	if (dropletId) {
		ui.info("Ensuring cloud firewall is configured...");
		const fw = await ensureFirewall(ctx.doToken, dropletId);
		ui.success(`Firewall ${ui.bold(fw.name)} active`);
	}

	// Assign a reserved IP (static, survives droplet recreation, used for DNS and deploy)
	if (dropletId) {
		await handleReservedIp(ctx, dropletId);
	}

	ctx.sshUser = await input({
		message: `${ui.cyan("SSH user")} on the Droplet:`,
		default: ctx.sshUser || "root",
	});

	// For existing droplets, copy the deploy key to authorized_keys
	if (!isNewDroplet) {
		await copySshKey(ctx);
	}

	// Verify the deploy key can actually authenticate to the droplet
	await verifyDeployKey(ctx);
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

async function createDroplet(ctx: SetupContext): Promise<number> {
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

	// Fetch regions and sizes from the API
	ui.info("Fetching available regions and sizes...");
	const [regions, sizes] = await Promise.all([listRegions(ctx.doToken), listSizes(ctx.doToken)]);

	const region = await select({
		message: `${ui.cyan("Region")}:`,
		choices: regions.map((r) => ({
			name: `${ui.bold(r.slug)} ${ui.dim("—")} ${ui.dim(r.name)}`,
			value: r.slug,
		})),
		default: "nyc1",
	});

	// Filter sizes to those available in the selected region
	const regionSizes = sizes.filter((s) => s.regions.includes(region));

	const formatMem = (mb: number) => (mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`);

	const size = await select({
		message: `${ui.cyan("Droplet size")}:`,
		choices: regionSizes.map((s) => ({
			name: `${ui.bold(s.slug)}  ${ui.dim(`${s.vcpus} vCPU / ${formatMem(s.memory)} RAM / ${s.disk}GB disk`)}  ${ui.green(`$${s.priceMonthly}/mo`)}`,
			value: s.slug,
		})),
		default: "s-2vcpu-4gb",
	});

	// Look up the deploy key fingerprint (already registered in run())
	let sshKeyFingerprint = "";
	if (ctx.sshPublicKeyPath) {
		const pubKey = readFileSync(ctx.sshPublicKeyPath, "utf-8").trim();
		const keyInfo = await addSshKey(ctx.doToken, SSH_KEY_NAME, pubKey);
		sshKeyFingerprint = keyInfo.fingerprint;
	}

	ui.info("Creating Droplet (this takes 1-2 minutes)...");

	// Write cloud-init to a platform-safe temp location
	const tmpInit = join(tmpdir(), "olympusoss-cloud-init.yml");
	writeFileSync(tmpInit, CLOUD_INIT);

	const createArgs = [
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
	];

	// Pass the SSH key so the droplet boots with it pre-installed (no password needed)
	if (sshKeyFingerprint) {
		createArgs.push("--ssh-keys", sshKeyFingerprint);
	}

	const result = await execOrThrow("doctl", createArgs, { timeout: 180_000 });

	const parts = result.split(/\s+/);
	const dropletId = Number.parseInt(parts[0], 10);
	const ip = parts[1];

	if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
		throw new Error(`Could not parse Droplet IP from doctl output: ${result}`);
	}

	ctx.dropletName = name;
	ctx.dropletIp = ip;
	ui.success(`Droplet created: ${ui.bold(name)} (${ui.host(ip)})`);

	// Wait for SSH to become available (use the deploy key, no password)
	ui.info("Waiting for SSH to become available...");
	const sshOpts = [
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=5",
		"-o", "PasswordAuthentication=no",
		"-o", "BatchMode=yes",
	];
	if (ctx.sshPrivateKeyPath) {
		sshOpts.push("-i", ctx.sshPrivateKeyPath);
	}
	for (let i = 0; i < 30; i++) {
		const ssh = await exec("ssh", [...sshOpts, `root@${ip}`, "echo ok"]);
		if (ssh.exitCode === 0) {
			ui.success("SSH is ready");
			return dropletId;
		}
		await new Promise((r) => setTimeout(r, 5000));
	}
	ui.warn("SSH not responding yet — it may need a few more minutes for cloud-init to complete");
	return dropletId;
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

async function handleReservedIp(ctx: SetupContext, dropletId: number): Promise<void> {
	ui.info("Checking for reserved IPs...");
	const reservedIps = await listReservedIps(ctx.doToken);

	// Separate into unassigned and already-assigned-to-this-droplet
	const assignedToDroplet = reservedIps.find((r) => r.dropletId === dropletId);
	const unassigned = reservedIps.filter((r) => r.dropletId === null);

	if (assignedToDroplet) {
		// This droplet already has a reserved IP
		ctx.reservedIp = assignedToDroplet.ip;
		ctx.dropletIp = assignedToDroplet.ip;
		ui.success(`Reserved IP ${ui.host(assignedToDroplet.ip)} already assigned to this droplet`);
		return;
	}

	// Build choices: unassigned IPs + create new
	const choices: { name: string; value: string }[] = unassigned.map((r) => ({
		name: `${ui.bold(r.ip)} ${ui.dim(`(${r.region}, unassigned)`)}`,
		value: r.ip,
	}));
	choices.push({
		name: `${ui.bold("Create new")} ${ui.dim("— allocate a new reserved IP")}`,
		value: "__new__",
	});

	const chosen = await select({
		message: `${ui.cyan("Reserved IP")} ${ui.dim("(static IP for DNS & deploy)")}:`,
		choices,
	});

	let ip: string;
	if (chosen === "__new__") {
		// We need the droplet's region to create a reserved IP in the same region
		const droplets = await listDroplets(ctx.doToken);
		const droplet = droplets.find((d) => d.id === dropletId);
		// Fall back to nyc1 if we can't determine the region
		const region = droplet ? await getDropletRegion(ctx.doToken, dropletId) : "nyc1";
		ui.info(`Creating reserved IP in ${ui.bold(region)}...`);
		ip = await createReservedIp(ctx.doToken, region);
		ui.success(`Created reserved IP ${ui.host(ip)}`);
	} else {
		ip = chosen;
	}

	// Assign to the droplet
	ui.info(`Assigning ${ui.host(ip)} to droplet ${ui.bold(ctx.dropletName)}...`);
	await assignReservedIp(ctx.doToken, ip, dropletId);
	ctx.reservedIp = ip;
	ctx.dropletIp = ip;
	ui.success(`Reserved IP ${ui.host(ip)} assigned — use this for DNS and deploy`);
}

/**
 * Get a droplet's region slug from the API.
 */
async function getDropletRegion(token: string, dropletId: number): Promise<string> {
	const res = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});
	if (!res.ok) return "nyc1";
	const data = await res.json();
	return data.droplet?.region?.slug ?? "nyc1";
}

async function copySshKey(ctx: SetupContext): Promise<void> {
	if (!ctx.sshPublicKeyPath || !ctx.dropletIp) return;

	const pubKey = readFileSync(ctx.sshPublicKeyPath, "utf-8").trim();
	const sshTarget = `${ctx.sshUser}@${ctx.dropletIp}`;

	ui.info(`Copying deploy public key to ${ui.host(ctx.dropletIp)}...`);
	ui.info(`Key: ${ui.cmd(ctx.sshPublicKeyPath)}`);

	// ssh-copy-id is not available on Windows; use ssh + cat pipe as a cross-platform fallback
	const hasSshCopyId = await commandExists("ssh-copy-id");

	if (hasSshCopyId) {
		const result = await exec("ssh-copy-id", [
			"-i",
			ctx.sshPublicKeyPath,
			"-o",
			"StrictHostKeyChecking=accept-new",
			sshTarget,
		]);
		if (result.exitCode === 0) {
			ui.success("Deploy key installed on Droplet");
			return;
		}
		ui.warn("ssh-copy-id failed, trying fallback...");
	}

	// Fallback: read key and pipe it via ssh (works on Windows with OpenSSH)
	// Idempotent — only appends if not already present
	const appendCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '${pubKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

	const result = await exec("ssh", ["-o", "StrictHostKeyChecking=accept-new", sshTarget, appendCmd]);

	if (result.exitCode === 0) {
		ui.success("Deploy key installed on Droplet");
	} else {
		throw new Error(
			`Failed to install deploy key on Droplet. ` +
			`You must manually add the public key to ${ctx.sshUser}@${ctx.dropletIp}:~/.ssh/authorized_keys\n` +
			`Key file: ${ctx.sshPublicKeyPath}`,
		);
	}
}

/**
 * Verify the deploy key can SSH into the droplet.
 * This is the same key that will be stored in GitHub Secrets as DEPLOY_SSH_KEY.
 */
async function verifyDeployKey(ctx: SetupContext): Promise<void> {
	if (!ctx.sshPrivateKeyPath || !ctx.dropletIp) return;

	ui.info("Verifying deploy key authenticates to Droplet...");
	ui.info(`Private key: ${ui.cmd(ctx.sshPrivateKeyPath)} → GitHub DEPLOY_SSH_KEY`);
	ui.info(`Public key:  ${ui.cmd(ctx.sshPublicKeyPath)} → Droplet authorized_keys`);

	const sshOpts = [
		"-i", ctx.sshPrivateKeyPath,
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=10",
		"-o", "PasswordAuthentication=no",
		"-o", "BatchMode=yes",
		"-o", "IdentitiesOnly=yes",
	];
	const sshTarget = `${ctx.sshUser}@${ctx.dropletIp}`;

	const result = await exec("ssh", [...sshOpts, sshTarget, "echo ok"]);

	if (result.exitCode === 0) {
		ui.success("Deploy key verified — GitHub Actions will be able to SSH in");
	} else {
		throw new Error(
			`Deploy key verification FAILED. The key at ${ctx.sshPrivateKeyPath} cannot authenticate to ${ctx.dropletIp}.\n` +
			`This means GitHub Actions will also fail to deploy.\n` +
			`Ensure the public key (${ctx.sshPublicKeyPath}) is in ${ctx.sshUser}@${ctx.dropletIp}:~/.ssh/authorized_keys`,
		);
	}
}
