/**
 * Default Athena dashboard layout — seeded into IAM identities at creation
 * so the dashboard loads with a pre-configured layout on first login.
 *
 * Users can customise the layout after login; changes are persisted to
 * their own metadata_public.dashboardLayout in Kratos.
 */
export const DEFAULT_DASHBOARD_LAYOUT = {
	widgets: [
		{ i: "stat-total-users", x: 0, y: 0, w: 2, h: 3 },
		{ i: "stat-active-sessions", x: 2, y: 0, w: 2, h: 3 },
		{ i: "stat-avg-session", x: 4, y: 0, w: 2, h: 3 },
		{ i: "stat-user-growth", x: 6, y: 0, w: 2, h: 3 },
		{ i: "chart-security-insights", x: 8, y: 0, w: 4, h: 3, minW: 2, minH: 3 },
		{ i: "chart-combined-activity", x: 0, y: 3, w: 12, h: 4, minW: 4, minH: 2 },
		{ i: "chart-users-by-schema", x: 0, y: 13, w: 3, h: 4, minW: 2, minH: 3 },
		{ i: "chart-verification-gauge", x: 9, y: 7, w: 3, h: 4, minW: 2, minH: 3 },
		{ i: "chart-peak-hours", x: 6, y: 11, w: 6, h: 6, minW: 3, minH: 3 },
		{ i: "chart-session-locations", x: 0, y: 7, w: 6, h: 6, minW: 4, minH: 4 },
		{ i: "chart-activity-feed", x: 6, y: 7, w: 3, h: 4, minW: 2, minH: 3 },
		{ i: "chart-oauth2-grant-types", x: 3, y: 13, w: 3, h: 4, minW: 2, minH: 3 },
	],
	hiddenWidgets: [] as string[],
};
