import { pbkdf2Sync } from "node:crypto";

const SALT_PREFIX = "olympusoss";
const ITERATIONS = 600_000;
const DIGEST = "sha256";

/**
 * Derive a deterministic hex secret from a passphrase.
 *
 * Same passphrase + same name always produces the same output.
 * Each secret name gets a unique salt so all derived values are independent.
 *
 * @param passphrase  User-provided passphrase
 * @param name        Unique identifier for this secret (e.g. "POSTGRES_PASSWORD")
 * @param bytes       Number of bytes to derive (output will be bytes * 2 hex chars)
 */
export function deriveSecret(passphrase: string, name: string, bytes: number): string {
	const salt = `${SALT_PREFIX}:${name}`;
	return pbkdf2Sync(passphrase, salt, ITERATIONS, bytes, DIGEST).toString("hex");
}

/**
 * Derive all secrets needed for the OlympusOSS platform.
 *
 * @param passphrase      User-provided passphrase
 * @param includeSite     Whether to generate site OAuth2 secrets
 * @returns Map of secret name → hex value
 */
export function deriveAllSecrets(passphrase: string, includeSite: boolean): Record<string, string> {
	const secrets: Record<string, string> = {
		// CIAM Kratos
		CIAM_KRATOS_SECRET_COOKIE: deriveSecret(passphrase, "CIAM_KRATOS_SECRET_COOKIE", 32),
		CIAM_KRATOS_SECRET_CIPHER: deriveSecret(passphrase, "CIAM_KRATOS_SECRET_CIPHER", 16), // exactly 32 hex chars

		// IAM Kratos
		IAM_KRATOS_SECRET_COOKIE: deriveSecret(passphrase, "IAM_KRATOS_SECRET_COOKIE", 32),
		IAM_KRATOS_SECRET_CIPHER: deriveSecret(passphrase, "IAM_KRATOS_SECRET_CIPHER", 16), // exactly 32 hex chars

		// CIAM Hydra
		CIAM_HYDRA_SECRET_SYSTEM: deriveSecret(passphrase, "CIAM_HYDRA_SECRET_SYSTEM", 32),
		CIAM_HYDRA_PAIRWISE_SALT: deriveSecret(passphrase, "CIAM_HYDRA_PAIRWISE_SALT", 32),

		// IAM Hydra
		IAM_HYDRA_SECRET_SYSTEM: deriveSecret(passphrase, "IAM_HYDRA_SECRET_SYSTEM", 32),
		IAM_HYDRA_PAIRWISE_SALT: deriveSecret(passphrase, "IAM_HYDRA_PAIRWISE_SALT", 32),

		// OAuth2 client secrets
		ATHENA_CIAM_OAUTH_CLIENT_SECRET: deriveSecret(passphrase, "ATHENA_CIAM_OAUTH_CLIENT_SECRET", 32),
		ATHENA_IAM_OAUTH_CLIENT_SECRET: deriveSecret(passphrase, "ATHENA_IAM_OAUTH_CLIENT_SECRET", 32),
	};

	// pgAdmin (always — admin tool)
	secrets.PGADMIN_OAUTH_CLIENT_SECRET = deriveSecret(passphrase, "PGADMIN_OAUTH_CLIENT_SECRET", 32);

	if (includeSite) {
		secrets.SITE_CIAM_CLIENT_SECRET = deriveSecret(passphrase, "SITE_CIAM_CLIENT_SECRET", 32);
		secrets.SITE_IAM_CLIENT_SECRET = deriveSecret(passphrase, "SITE_IAM_CLIENT_SECRET", 32);
	}

	return secrets;
}
