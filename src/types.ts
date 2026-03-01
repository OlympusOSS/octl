/** Steps the user can select from the main menu. */
export type StepId = "resend" | "neon" | "droplet" | "github-env" | "github-secrets" | "github-vars" | "app-deploy-secrets";

export interface StepDef {
	id: StepId;
	label: string;
	description: string;
	run: (ctx: SetupContext) => Promise<void>;
}

/** DNS record returned by Resend after adding a domain. */
export interface DnsRecord {
	type: string;
	name: string;
	value: string;
	priority?: number;
	ttl?: string;
}

/** Accumulated context passed through every step. */
export interface SetupContext {
	/** Which steps the user selected to run. */
	selectedSteps: StepId[];

	/** Base domain (e.g. "nannier.com"). */
	domain: string;

	/** Passphrase used to derive all secrets via PBKDF2. */
	passphrase: string;

	/** Admin identity email (default: admin@{domain}). */
	adminEmail: string;

	/** Admin identity password. */
	adminPassword: string;

	/** Whether to include site OAuth2 clients. */
	includeSite: boolean;

	/** Droplet public IP. Set by step 3 or prompted. Prefers reserved IP when available. */
	dropletIp: string;

	/** Droplet name (e.g. "olympusoss-prod"). */
	dropletName: string;

	/** DigitalOcean reserved IP assigned to the droplet (static, survives droplet recreation). */
	reservedIp: string;

	/** Path to generated SSH private key for deploy. */
	sshPrivateKeyPath: string;

	/** Path to generated SSH public key for deploy. */
	sshPublicKeyPath: string;

	/** SSH user on the Droplet (default: root). */
	sshUser: string;

	/** Resend API key (starts with re_). */
	resendApiKey: string;

	/** DNS records returned by Resend for email verification. */
	resendDnsRecords: DnsRecord[];

	/** Neon API token for managed PostgreSQL. */
	neonApiToken: string;

	/** Neon organization ID (resolved via /users/me). */
	neonOrgId: string;

	/** Neon project ID (set by neon step). */
	neonProjectId: string;

	/** Neon connection strings per database. */
	neonDsns: {
		ciamKratos: string;
		ciamHydra: string;
		iamKratos: string;
		iamHydra: string;
	};

	/** GitHub PAT with read:packages scope for GHCR pulls. */
	ghcrPat: string;

	/** GitHub username for GHCR. */
	ghcrUsername: string;

	/** GitHub PAT for cross-repo dispatches (repo scope). */
	orgDispatchToken: string;

	/** GitHub repo owner (e.g. "OlympusOSS"). */
	repoOwner: string;

	/** GitHub repo name (e.g. "platform"). */
	repoName: string;

	/** DigitalOcean API token (only needed if creating new Droplet). */
	doToken: string;

	/** SSH port on the Droplet. */
	sshPort: number;

	/** Deploy path on the Droplet. */
	deployPath: string;

	/** Derived secrets (PBKDF2) — stored for reference, re-derived each run. */
	derivedSecrets: Record<string, string>;

	/** Full map of GitHub secrets set on the production environment. */
	githubSecrets: Record<string, string>;

	/** Full map of GitHub variables set on the production environment. */
	githubVariables: Record<string, string>;
}

/** Create an empty context with sane defaults. */
export function createEmptyContext(): SetupContext {
	return {
		selectedSteps: [],
		domain: "",
		passphrase: "",
		adminEmail: "",
		adminPassword: "",
		includeSite: false,
		dropletIp: "",
		dropletName: "",
		reservedIp: "",
		sshPrivateKeyPath: "",
		sshPublicKeyPath: "",
		sshUser: "root",
		resendApiKey: "",
		resendDnsRecords: [],
		neonApiToken: "",
		neonOrgId: "",
		neonProjectId: "",
		neonDsns: { ciamKratos: "", ciamHydra: "", iamKratos: "", iamHydra: "" },
		ghcrPat: "",
		ghcrUsername: "",
		orgDispatchToken: "",
		repoOwner: "",
		repoName: "",
		doToken: "",
		sshPort: 22,
		deployPath: "/opt/olympusoss/prod",
		derivedSecrets: {},
		githubSecrets: {},
		githubVariables: {},
	};
}
