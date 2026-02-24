/** Steps the user can select from the main menu. */
export type StepId = "resend" | "hostinger" | "droplet" | "github-env" | "github-secrets" | "github-vars" | "deploy";

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

	/** Whether to include demo app OAuth2 clients. */
	includeDemo: boolean;

	/** Droplet public IP. Set by step 3 or prompted. */
	dropletIp: string;

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

	/** Hostinger API token (empty = skip DNS automation). */
	hostingerToken: string;

	/** GitHub PAT with read:packages scope for GHCR pulls. */
	ghcrPat: string;

	/** GitHub username for GHCR. */
	ghcrUsername: string;

	/** GitHub repo owner (e.g. "bnannier"). */
	repoOwner: string;

	/** GitHub repo name (e.g. "OlympusOSS"). */
	repoName: string;

	/** DigitalOcean API token (only needed if creating new Droplet). */
	doToken: string;

	/** SSH port on the Droplet. */
	sshPort: number;

	/** Deploy path on the Droplet. */
	deployPath: string;
}

/** Create an empty context with sane defaults. */
export function createEmptyContext(): SetupContext {
	return {
		selectedSteps: [],
		domain: "",
		passphrase: "",
		adminEmail: "",
		adminPassword: "",
		includeDemo: false,
		dropletIp: "",
		sshPrivateKeyPath: "",
		sshPublicKeyPath: "",
		sshUser: "root",
		resendApiKey: "",
		resendDnsRecords: [],
		hostingerToken: "",
		ghcrPat: "",
		ghcrUsername: "",
		repoOwner: "",
		repoName: "",
		doToken: "",
		sshPort: 22,
		deployPath: "/opt/olympusoss/prod",
	};
}
