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

	let projectId = ctx.neonProjectId;
	let branchId = "";
	let host = "";
	let role = "";
	let password = "";

	if (projectId) {
		// Reuse existing project — fetch its details
		ui.skip(`Neon project ${ui.label(projectId)} already exists`);

		const projRes = await fetch(`${NEON_API}/projects/${projectId}`, { headers });
		if (!projRes.ok) {
			throw new Error(`Failed to fetch Neon project: ${await projRes.text()}`);
		}
		const projData = await projRes.json();
		branchId = projData.project?.default_branch_id ?? "";

		// Get the endpoint host
		const endpointsRes = await fetch(`${NEON_API}/projects/${projectId}/endpoints`, { headers });
		if (!endpointsRes.ok) {
			throw new Error(`Failed to fetch Neon endpoints: ${await endpointsRes.text()}`);
		}
		const endpointsData = await endpointsRes.json();
		const endpoint = endpointsData.endpoints?.[0];
		if (endpoint) {
			host = endpoint.host;
		}

		// Get the role
		const rolesRes = await fetch(`${NEON_API}/projects/${projectId}/branches/${branchId}/roles`, {
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
			const pwRes = await fetch(`${NEON_API}/projects/${projectId}/branches/${branchId}/roles/${role}/reveal_password`, { method: "GET", headers });
			if (pwRes.ok) {
				const pwData = await pwRes.json();
				password = pwData.password ?? "";
			}
		}
	} else {
		// Create a new project
		ui.info("Creating Neon project...");

		const createRes = await fetch(`${NEON_API}/projects`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				project: {
					name: `olympus-${ctx.domain || "prod"}`,
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
	}

	if (!branchId || !host || !role || !password) {
		throw new Error(`Missing Neon connection info: branch=${branchId}, host=${host}, role=${role}, password=${password ? "***" : "empty"}`);
	}

	// Create databases (idempotent — skip if already exists)
	ui.info("Creating databases...");

	// First, list existing databases
	const dbListRes = await fetch(`${NEON_API}/projects/${projectId}/branches/${branchId}/databases`, {
		headers,
	});
	const dbListData = dbListRes.ok ? await dbListRes.json() : { databases: [] };
	const existingDbs = new Set((dbListData.databases ?? []).map((d: any) => d.name));

	for (const dbName of DB_NAMES) {
		if (existingDbs.has(dbName)) {
			ui.skip(`Database ${ui.label(dbName)} already exists`);
		} else {
			const dbRes = await fetch(`${NEON_API}/projects/${projectId}/branches/${branchId}/databases`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					database: { name: dbName, owner_name: role },
				}),
			});

			if (!dbRes.ok) {
				const err = await dbRes.text();
				throw new Error(`Failed to create database ${dbName}: ${err}`);
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
