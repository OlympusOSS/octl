/**
 * Kratos Admin API helpers for octl.
 *
 * Provides functions to look up, create, and patch identities
 * via the Kratos Admin REST API. Accepts an optional `fetcher`
 * parameter to route requests through SSH in production.
 */

import { defaultFetcher, type KratosFetcher } from "./ssh-fetch.js";
import * as ui from "./ui.js";

export type { KratosFetcher };

export interface KratosIdentity {
	id: string;
	schema_id: string;
	traits: Record<string, unknown>;
	metadata_admin?: Record<string, unknown>;
	state: string;
}

export interface CreateIdentityPayload {
	schema_id: string;
	traits: Record<string, unknown>;
	credentials: { password: { config: { password: string } } };
	metadata_admin: Record<string, unknown>;
	state: string;
}

/** Check if a Kratos instance is healthy. */
export async function checkHealth(kratosAdminUrl: string, fetcher: KratosFetcher = defaultFetcher): Promise<boolean> {
	try {
		const res = await fetcher(`${kratosAdminUrl}/health/ready`);
		return res.ok;
	} catch (err) {
		ui.warn(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/**
 * Find an identity by email (credentials_identifier).
 * Returns the first matching identity or null.
 */
export async function findIdentityByEmail(
	kratosAdminUrl: string,
	email: string,
	fetcher: KratosFetcher = defaultFetcher,
): Promise<KratosIdentity | null> {
	const res = await fetcher(`${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`);
	if (!res.ok) return null;

	const identities: KratosIdentity[] = await res.json();
	return identities.length > 0 ? identities[0] : null;
}

/** Create a new identity in Kratos. */
export async function createIdentity(
	kratosAdminUrl: string,
	payload: CreateIdentityPayload,
	fetcher: KratosFetcher = defaultFetcher,
): Promise<KratosIdentity> {
	const res = await fetcher(`${kratosAdminUrl}/admin/identities`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to create identity: ${res.status} ${body}`);
	}

	return res.json();
}

/**
 * Update an identity's metadata_admin via PUT.
 *
 * Kratos JSON Patch (RFC 6902) fails when metadata_admin is null,
 * so we use PUT instead: fetch the current identity, preserve its
 * schema_id / traits / state, and set the new metadata_admin.
 */
export async function patchIdentityMetadata(
	kratosAdminUrl: string,
	identityId: string,
	metadataAdmin: Record<string, unknown>,
	fetcher: KratosFetcher = defaultFetcher,
): Promise<void> {
	// GET the current identity to preserve traits
	const getRes = await fetcher(`${kratosAdminUrl}/admin/identities/${identityId}`);
	if (!getRes.ok) {
		const body = await getRes.text();
		throw new Error(`Failed to fetch identity ${identityId}: ${getRes.status} ${body}`);
	}

	const identity: KratosIdentity = await getRes.json();

	// PUT with updated metadata_admin (credentials are omitted — PUT doesn't require them)
	const res = await fetcher(`${kratosAdminUrl}/admin/identities/${identityId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			schema_id: identity.schema_id,
			traits: identity.traits,
			metadata_admin: metadataAdmin,
			state: identity.state,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to update identity ${identityId}: ${res.status} ${body}`);
	}
}

/**
 * List all identities that have metadata_admin.demo === true.
 * Fetches up to 500 identities and filters client-side.
 */
export async function listDemoIdentities(kratosAdminUrl: string, fetcher: KratosFetcher = defaultFetcher): Promise<KratosIdentity[]> {
	const res = await fetcher(`${kratosAdminUrl}/admin/identities?per_page=500`);
	if (!res.ok) return [];

	const identities: KratosIdentity[] = await res.json();
	return identities.filter((i) => i.metadata_admin?.demo === true);
}

/** Delete an identity by ID. */
export async function deleteIdentity(kratosAdminUrl: string, identityId: string, fetcher: KratosFetcher = defaultFetcher): Promise<void> {
	const res = await fetcher(`${kratosAdminUrl}/admin/identities/${identityId}`, { method: "DELETE" });

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to delete identity ${identityId}: ${res.status} ${body}`);
	}
}
