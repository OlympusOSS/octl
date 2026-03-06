import { confirm, input, select } from "@inquirer/prompts";
import type { KratosFetcher } from "../lib/kratos.js";
import * as kratos from "../lib/kratos.js";
import { saveSettings } from "../lib/settings.js";
import { closeSshConnection, createSshFetcher, defaultFetcher, openSshConnection } from "../lib/ssh-fetch.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

type ModifyAction = "add-demo" | "remove-demo" | "add-admin";

/** Extract email from a Kratos identity's traits (loosely typed). */
function getEmail(identity: kratos.KratosIdentity): string {
	const traits = identity.traits as Record<string, unknown>;
	return typeof traits.email === "string" ? traits.email : identity.id;
}

/** Demo identity definitions for prod. */
interface DemoIdentityDef {
	realm: "iam" | "ciam";
	email: string;
	schema_id: string;
	traits: Record<string, unknown>;
	password: string;
}

function getDemoIdentities(adminPassword: string): DemoIdentityDef[] {
	return [
		{
			realm: "iam",
			email: "admin@demo.user",
			schema_id: "admin",
			traits: {
				email: "admin@demo.user",
				name: { first: "Admin", last: "User" },
				role: "admin",
			},
			password: adminPassword,
		},
		{
			realm: "iam",
			email: "viewer@demo.user",
			schema_id: "admin",
			traits: {
				email: "viewer@demo.user",
				name: { first: "Demo", last: "Viewer" },
				role: "viewer",
			},
			password: adminPassword,
		},
		{
			realm: "ciam",
			email: "demo@demo.user",
			schema_id: "customer",
			traits: {
				email: "demo@demo.user",
				customer_id: "CUST-999",
				first_name: "Demo",
				last_name: "User",
				loyalty_tier: "gold",
				account_status: "active",
			},
			password: adminPassword,
		},
	];
}

// ── Kratos endpoint resolution ───────────────────────────────

interface KratosEndpoint {
	iam: string;
	ciam: string;
	fetcher: KratosFetcher;
	cleanup: () => Promise<void>;
	isProd: boolean;
}

/**
 * Resolve Kratos admin endpoints and transport.
 *
 * - Dev mode: direct fetch to localhost ports
 * - Prod mode: SSH into Droplet, curl Kratos on localhost
 */
async function resolveKratosEndpoint(ctx: SetupContext): Promise<KratosEndpoint> {
	const isProd = ctx.mode === "prod" && !!ctx.dropletIp;

	if (!isProd) {
		// Dev mode — direct localhost access
		return {
			iam: "http://localhost:4101",
			ciam: "http://localhost:3101",
			fetcher: defaultFetcher,
			cleanup: async () => {},
			isProd: false,
		};
	}

	// Prod mode — validate SSH fields
	if (!ctx.sshPrivateKeyPath) {
		ctx.sshPrivateKeyPath = await input({
			message: `${ui.cyan("SSH private key path")}:`,
			default: ctx.sshPrivateKeyPath || undefined,
			validate: (v) => (v.length > 0 ? true : "Path cannot be empty"),
		});
		saveSettings(ctx, true);
	}

	// Open SSH ControlMaster connection
	await openSshConnection(ctx);

	return {
		iam: "http://localhost:4101",
		ciam: "http://localhost:3101",
		fetcher: createSshFetcher(ctx),
		cleanup: () => closeSshConnection(ctx),
		isProd: true,
	};
}

async function healthCheck(endpoint: KratosEndpoint): Promise<void> {
	const via = endpoint.isProd ? " (via SSH)" : "";
	ui.info(`Checking Kratos health${via}...`);

	const iamOk = await kratos.checkHealth(endpoint.iam, endpoint.fetcher);
	if (!iamOk) {
		throw new Error(`IAM Kratos is not reachable at ${endpoint.iam}${via}. Ensure services are running.`);
	}
	ui.success(`IAM Kratos healthy${via}`);

	const ciamOk = await kratos.checkHealth(endpoint.ciam, endpoint.fetcher);
	if (!ciamOk) {
		throw new Error(`CIAM Kratos is not reachable at ${endpoint.ciam}${via}. Ensure services are running.`);
	}
	ui.success(`CIAM Kratos healthy${via}`);
}

// ── Add Demo Accounts ─────────────────────────────────────────

async function addDemoAccounts(ctx: SetupContext): Promise<void> {
	const endpoint = await resolveKratosEndpoint(ctx);

	try {
		await healthCheck(endpoint);

		// Collect password for demo accounts
		const demoPassword = await input({
			message: `${ui.cyan("Demo account password")}:`,
			default: ctx.adminPassword || "admin123!",
			validate: (v) => (v.length >= 8 ? true : "Password must be at least 8 characters"),
		});

		const identities = getDemoIdentities(demoPassword);

		console.log("");
		ui.info(ui.bold("Seeding demo identities..."));

		for (const def of identities) {
			const kratosUrl = def.realm === "iam" ? endpoint.iam : endpoint.ciam;
			const demoMeta = { demo: true, password: def.password };

			ui.info(`Processing ${ui.bold(def.email)} (${def.realm.toUpperCase()})...`);

			const existing = await kratos.findIdentityByEmail(kratosUrl, def.email, endpoint.fetcher);

			if (existing) {
				const currentMeta = existing.metadata_admin;
				if (currentMeta?.demo === true && currentMeta?.password === def.password) {
					ui.skip(`${def.email} already has demo metadata`);
					continue;
				}

				await kratos.patchIdentityMetadata(kratosUrl, existing.id, demoMeta, endpoint.fetcher);
				ui.success(`Patched demo metadata on ${ui.bold(def.email)}`);
			} else {
				await kratos.createIdentity(
					kratosUrl,
					{
						schema_id: def.schema_id,
						traits: def.traits,
						credentials: { password: { config: { password: def.password } } },
						metadata_admin: demoMeta,
						state: "active",
					},
					endpoint.fetcher,
				);
				ui.success(`Created ${ui.bold(def.email)}`);
			}
		}

		console.log("");
		ui.success("Demo accounts seeded");
	} finally {
		await endpoint.cleanup();
	}
}

// ── Remove Demo Accounts ──────────────────────────────────────

async function removeDemoAccounts(ctx: SetupContext): Promise<void> {
	const endpoint = await resolveKratosEndpoint(ctx);

	try {
		await healthCheck(endpoint);

		console.log("");
		ui.info(ui.bold("Finding demo identities..."));

		const iamDemos = await kratos.listDemoIdentities(endpoint.iam, endpoint.fetcher);
		const ciamDemos = await kratos.listDemoIdentities(endpoint.ciam, endpoint.fetcher);

		if (iamDemos.length === 0 && ciamDemos.length === 0) {
			ui.info("No demo identities found.");
			return;
		}

		ui.info(`Found ${ui.bold(String(iamDemos.length))} IAM demo identities:`);
		for (const id of iamDemos) {
			const email = getEmail(id);
			ui.keyValue(`  ${email}`, ui.dim(id.id));
		}

		ui.info(`Found ${ui.bold(String(ciamDemos.length))} CIAM demo identities:`);
		for (const id of ciamDemos) {
			const email = getEmail(id);
			ui.keyValue(`  ${email}`, ui.dim(id.id));
		}

		console.log("");
		const proceed = await confirm({
			message: `Remove demo metadata from all ${iamDemos.length + ciamDemos.length} identities?`,
			default: false,
		});
		if (!proceed) {
			ui.info("Cancelled.");
			return;
		}

		// Clear demo metadata from IAM identities
		for (const id of iamDemos) {
			await kratos.patchIdentityMetadata(endpoint.iam, id.id, {}, endpoint.fetcher);
			const email = getEmail(id);
			ui.success(`Cleared demo metadata from ${ui.bold(email)}`);
		}

		// For CIAM demo identities, offer to fully delete (they're demo-only)
		for (const id of ciamDemos) {
			const email = getEmail(id);
			const isDemoOnly = email === "demo@demo.user";

			if (isDemoOnly) {
				const del = await confirm({
					message: `${email} is a demo-only identity. Delete it entirely?`,
					default: true,
				});
				if (del) {
					await kratos.deleteIdentity(endpoint.ciam, id.id, endpoint.fetcher);
					ui.success(`Deleted ${ui.bold(email)}`);
					continue;
				}
			}

			await kratos.patchIdentityMetadata(endpoint.ciam, id.id, {}, endpoint.fetcher);
			ui.success(`Cleared demo metadata from ${ui.bold(email)}`);
		}

		console.log("");
		ui.success("Demo accounts removed");
	} finally {
		await endpoint.cleanup();
	}
}

// ── Add Admin Account ─────────────────────────────────────────

async function addAdminAccount(ctx: SetupContext): Promise<void> {
	const endpoint = await resolveKratosEndpoint(ctx);

	try {
		// Only need IAM Kratos for admin accounts
		const via = endpoint.isProd ? " (via SSH)" : "";
		ui.info(`Checking IAM Kratos health${via}...`);
		const iamOk = await kratos.checkHealth(endpoint.iam, endpoint.fetcher);
		if (!iamOk) {
			throw new Error(`IAM Kratos is not reachable at ${endpoint.iam}${via}.`);
		}
		ui.success(`IAM Kratos healthy${via}`);

		console.log("");
		ui.info(ui.bold("Create a new IAM admin identity:"));

		const email = await input({
			message: `${ui.cyan("Email")}:`,
			validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? true : "Enter a valid email address"),
		});

		const firstName = await input({
			message: `${ui.cyan("First name")}:`,
			validate: (v) => (v.length > 0 ? true : "Cannot be empty"),
		});

		const lastName = await input({
			message: `${ui.cyan("Last name")}:`,
			validate: (v) => (v.length > 0 ? true : "Cannot be empty"),
		});

		const role = await select<string>({
			message: `${ui.cyan("Role")}:`,
			choices: [
				{ name: "Admin", value: "admin" },
				{ name: "Viewer", value: "viewer" },
			],
		});

		const pw = await input({
			message: `${ui.cyan("Password")}:`,
			validate: (v) => (v.length >= 8 ? true : "Password must be at least 8 characters"),
		});

		const markDemo = await confirm({
			message: "Mark as demo account? (shows on login page)",
			default: false,
		});

		// Check if identity already exists
		const existing = await kratos.findIdentityByEmail(endpoint.iam, email, endpoint.fetcher);
		if (existing) {
			ui.warn(`An identity with email ${ui.bold(email)} already exists (${existing.id}).`);
			const overwrite = await confirm({
				message: "Update this identity instead?",
				default: false,
			});
			if (!overwrite) {
				ui.info("Cancelled.");
				return;
			}

			const metadata = markDemo ? { demo: true, password: pw } : {};
			await kratos.patchIdentityMetadata(endpoint.iam, existing.id, metadata, endpoint.fetcher);
			ui.success(`Updated ${ui.bold(email)}`);
			return;
		}

		const metadata: Record<string, unknown> = markDemo ? { demo: true, password: pw } : {};

		await kratos.createIdentity(
			endpoint.iam,
			{
				schema_id: "admin",
				traits: {
					email,
					name: { first: firstName, last: lastName },
					role,
				},
				credentials: { password: { config: { password: pw } } },
				metadata_admin: metadata,
				state: "active",
			},
			endpoint.fetcher,
		);

		ui.success(`Created ${ui.bold(email)} (role: ${role}${markDemo ? ", demo" : ""})`);
	} finally {
		await endpoint.cleanup();
	}
}

// ── Entry point ───────────────────────────────────────────────

export async function run(ctx: SetupContext): Promise<void> {
	const action = await select<ModifyAction>({
		message: "What would you like to modify?",
		choices: [
			{
				name: `${ui.cyan("1.")} ${ui.bold("Add demo accounts")} ${ui.dim("— Seed demo identities into Kratos")}`,
				value: "add-demo",
			},
			{
				name: `${ui.cyan("2.")} ${ui.bold("Remove demo accounts")} ${ui.dim("— Clear demo metadata from all identities")}`,
				value: "remove-demo",
			},
			{
				name: `${ui.cyan("3.")} ${ui.bold("Add admin account")} ${ui.dim("— Create a new IAM admin identity")}`,
				value: "add-admin",
			},
		],
	});

	console.log("");

	switch (action) {
		case "add-demo":
			await addDemoAccounts(ctx);
			break;
		case "remove-demo":
			await removeDemoAccounts(ctx);
			break;
		case "add-admin":
			await addAdminAccount(ctx);
			break;
	}
}
