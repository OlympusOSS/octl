import { select } from "@inquirer/prompts";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

const NEON_API = "https://console.neon.tech/api/v2";

const DB_NAMES = ["ciam_kratos", "ciam_hydra", "iam_kratos", "iam_hydra"] as const;

type DbKey = "ciamKratos" | "ciamHydra" | "iamKratos" | "iamHydra";

/** Map database name → ctx.neonDsns key. */
function toDsnKey(dbName: string): DbKey {
	const map: Record<string, DbKey> = {
		ciam_kratos: "ciamKratos",
		ciam_hydra: "ciamHydra",
		iam_kratos: "iamKratos",
		iam_hydra: "iamHydra",
	};
	return map[dbName];
}

/**
 * Step — Neon: create a managed PostgreSQL project and databases.
 *
 * - Creates a Neon project (idempotent — reuses if neonProjectId is set)
 * - Creates 4 databases on the default branch
 * - Stores connection strings in ctx.neonDsns
 */
export async function run(ctx: SetupContext): Promise<void> {
	const headers = {
		Authorization: `Bearer ${ctx.neonApiToken}`,
		"Content-Type": "application/json",
	};

	// Always resolve org from API (saved value is just a hint, not trusted)
	const orgId = await resolveOrgId(headers);
	if (orgId) ctx.neonOrgId = orgId;

	/** Build a Neon API URL, appending org_id if available. */
	const neonUrl = (path: string) =>
		orgId ? `${NEON_API}${path}?org_id=${orgId}` : `${NEON_API}${path}`;

	let projectId = "";
	let branchId = "";
	let host = "";
	let role = "";
	let password = "";

	const projectName = `olympus.${ctx.domain || "prod"}`;

	// Always list projects from API and let user choose (saved ID used to pre-select)
	ui.info("Checking for existing Neon projects...");
	const listRes = await fetch(neonUrl("/projects"), { headers });
	if (listRes.ok) {
		const listData = await listRes.json();
		const projects: Array<{ id: string; name: string }> = listData.projects ?? [];

		if (projects.length > 0) {
			// Pre-select the saved project if it still exists
			const savedIdx = ctx.neonProjectId
				? projects.findIndex((p) => p.id === ctx.neonProjectId)
				: -1;

			const choices = [
				...projects.map((p) => ({
					name: `${ui.bold(p.name)} ${ui.dim(p.id)}`,
					value: p.id,
				})),
				{
					name: `${ui.bold("Create new")} ${ui.dim(`(${projectName})`)}`,
					value: "__new__",
				},
			];

			const chosen = await select({
				message: `${ui.cyan("Neon project")}:`,
				choices,
				default: savedIdx >= 0 ? projects[savedIdx].id : undefined,
			});

			if (chosen !== "__new__") {
				projectId = chosen;
				const proj = projects.find((p) => p.id === chosen);
				ui.success(`Using project ${ui.label(proj?.name ?? chosen)}`);
			}
		}
	}

	if (projectId) {
		// Reuse existing project — fetch its details
		ui.skip(`Neon project ${ui.label(projectId)} already exists`);

		const projRes = await fetch(neonUrl(`/projects/${projectId}`), { headers });
		if (!projRes.ok) {
			throw new Error(`Failed to fetch Neon project: ${await projRes.text()}`);
		}
		const projData = await projRes.json();
		branchId = projData.project?.default_branch_id ?? "";

		// Fallback: fetch branches if default_branch_id missing from project response
		if (!branchId) {
			const branchRes = await fetch(neonUrl(`/projects/${projectId}/branches`), { headers });
			if (branchRes.ok) {
				const branchData = await branchRes.json();
				const primary = (branchData.branches ?? []).find((b: any) => b.primary) ?? branchData.branches?.[0];
				if (primary) branchId = primary.id;
			}
		}

		if (!branchId) {
			throw new Error("Could not determine default branch for Neon project");
		}

		// Get the endpoint host
		const endpointsRes = await fetch(neonUrl(`/projects/${projectId}/endpoints`), { headers });
		if (!endpointsRes.ok) {
			throw new Error(`Failed to fetch Neon endpoints: ${await endpointsRes.text()}`);
		}
		const endpointsData = await endpointsRes.json();
		const endpoint = endpointsData.endpoints?.[0];
		if (endpoint) {
			host = endpoint.host;
		}

		// Get the role
		const rolesRes = await fetch(neonUrl(`/projects/${projectId}/branches/${branchId}/roles`), {
			headers,
		});
		if (!rolesRes.ok) {
			throw new Error(`Failed to fetch Neon roles: ${await rolesRes.text()}`);
		}
		const rolesData = await rolesRes.json();
		const ownerRole = rolesData.roles?.find((r: any) => r.name !== "web_access");
		if (ownerRole) {
			role = ownerRole.name;

			// Get password via reveal endpoint
			const pwRes = await fetch(neonUrl(`/projects/${projectId}/branches/${branchId}/roles/${role}/reveal_password`), { method: "GET", headers });
			if (pwRes.ok) {
				const pwData = await pwRes.json();
				password = pwData.password ?? "";
			}
		}
	} else {
		// Create a new project
		ui.info("Creating Neon project...");

		const createRes = await fetch(neonUrl("/projects"), {
			method: "POST",
			headers,
			body: JSON.stringify({
				project: {
					name: projectName,
					...(orgId ? { org_id: orgId } : {}),
					pg_version: 17,
				},
			}),
		});

		if (!createRes.ok) {
			throw new Error(`Failed to create Neon project: ${await createRes.text()}`);
		}

		const data = await createRes.json();
		projectId = data.project?.id ?? "";
		branchId = data.branch?.id ?? "";

		// Extract connection info from the creation response
		const connUri = data.connection_uris?.[0]?.connection_uri ?? "";
		if (connUri) {
			const parsed = new URL(connUri);
			host = parsed.hostname;
			role = decodeURIComponent(parsed.username);
			password = decodeURIComponent(parsed.password);
		}

		// Also check roles array in response
		if (!role && data.roles?.[0]) {
			role = data.roles[0].name;
		}
		if (!password && data.roles?.[0]?.password) {
			password = data.roles[0].password;
		}

		ctx.neonProjectId = projectId;
		ui.success(`Created project ${ui.label(projectId)}`);

		// Wait for project to finish initializing before creating databases
		ui.info("Waiting for project to be ready...");
		await waitForProject(headers, projectId, orgId);
	}

	if (!branchId || !host || !role || !password) {
		throw new Error(`Missing Neon connection info: branch=${branchId}, host=${host}, role=${role}, password=${password ? "***" : "empty"}`);
	}

	// Create databases (idempotent — skip if already exists)
	ui.info("Creating databases...");

	// First, list existing databases
	const dbListRes = await fetch(neonUrl(`/projects/${projectId}/branches/${branchId}/databases`), {
		headers,
	});
	const dbListData = dbListRes.ok ? await dbListRes.json() : { databases: [] };
	const existingDbs = new Set((dbListData.databases ?? []).map((d: any) => d.name));

	for (const dbName of DB_NAMES) {
		if (existingDbs.has(dbName)) {
			ui.skip(`Database ${ui.label(dbName)} already exists`);
		} else {
			// Retry with backoff — Neon may still have operations in progress
			let dbRes: Response | null = null;
			for (let attempt = 0; attempt < 5; attempt++) {
				dbRes = await fetch(neonUrl(`/projects/${projectId}/branches/${branchId}/databases`), {
					method: "POST",
					headers,
					body: JSON.stringify({
						database: { name: dbName, owner_name: role },
					}),
				});

				if (dbRes.ok) break;

				const body = await dbRes.text();
				if (body.includes("conflicting operations") && attempt < 4) {
					ui.info("Waiting for previous operation to complete...");
					await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
					continue;
				}

				throw new Error(`Failed to create database ${dbName}: ${body}`);
			}

			ui.success(`Created database ${ui.label(dbName)}`);
		}

		// Build connection string
		const dsn = `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}/${dbName}?sslmode=require`;
		ctx.neonDsns[toDsnKey(dbName)] = dsn;
	}

	ctx.neonProjectId = projectId;

	ui.info("Neon connection strings:");
	for (const dbName of DB_NAMES) {
		const key = toDsnKey(dbName);
		// Show DSN with password masked
		const masked = ctx.neonDsns[key].replace(/:([^@]+)@/, ":***@");
		ui.success(`${ui.label(dbName)} ${ui.dim("→")} ${ui.dim(masked)}`);
	}
}

/**
 * Resolve the Neon organization ID via /users/me/organizations.
 * Returns empty string for free/personal accounts with no org.
 */
async function resolveOrgId(headers: Record<string, string>): Promise<string> {
	ui.info("Resolving Neon organization...");

	const res = await fetch(`${NEON_API}/users/me/organizations`, { headers });
	if (!res.ok) {
		// Personal/free accounts may not support this endpoint — proceed without org
		ui.skip("No organization found — using personal account");
		return "";
	}

	const data = await res.json();
	const orgs: Array<{ id: string; name: string }> = data.organizations ?? data ?? [];

	if (orgs.length === 0) {
		ui.skip("No organization found — using personal account");
		return "";
	}

	if (orgs.length === 1) {
		ui.success(`Using org ${ui.bold(orgs[0].name)} (${ui.label(orgs[0].id)})`);
		return orgs[0].id;
	}

	// Multiple orgs — let the user pick
	const orgId = await select({
		message: `${ui.cyan("Neon organization")}:`,
		choices: orgs.map((o) => ({
			name: `${ui.bold(o.name)} ${ui.dim(o.id)}`,
			value: o.id,
		})),
	});

	return orgId;
}

/**
 * Poll the project's operations until none are running.
 * Neon rejects new operations while existing ones are in progress.
 */
async function waitForProject(headers: Record<string, string>, projectId: string, orgId: string): Promise<void> {
	const opsUrl = orgId
		? `${NEON_API}/projects/${projectId}/operations?org_id=${orgId}&limit=5`
		: `${NEON_API}/projects/${projectId}/operations?limit=5`;
	for (let i = 0; i < 20; i++) {
		const res = await fetch(opsUrl, { headers });
		if (!res.ok) break;

		const data = await res.json();
		const running = (data.operations ?? []).some((op: any) => op.status === "running" || op.status === "scheduling");

		if (!running) {
			ui.success("Project is ready");
			return;
		}

		await new Promise((r) => setTimeout(r, 2000));
	}
}
