/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

// Everything the UI loads (pages, API, uploads, previews, next/font) is
// same-origin. Next.js inlines its bootstrap scripts, and nonces would force
// every page to render dynamically, so script-src keeps 'unsafe-inline'.
// Dev mode also needs 'unsafe-eval' for React's debugging tools.
const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"font-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	// 'self', not 'none': downloads load in a hidden iframe so a failure can
	// be read and shown instead of replacing the app (see startDownload).
	"frame-ancestors 'self'",
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy", value: csp },
	{ key: "X-Frame-Options", value: "SAMEORIGIN" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	},
];

/** @type {import("next").NextConfig} */
const config = {
	output: "standalone",
	poweredByHeader: false,
	async headers() {
		return [{ source: "/:path*", headers: securityHeaders }];
	},
	// Lets pages prerender a static shell (e.g. the dashboard skeletons) while
	// deferring anything behind a Suspense boundary that reads per-request data
	// (headers/cookies/auth) to render dynamically at request time instead of
	// forcing the whole page to skip static generation.
	cacheComponents: true,
};

export default config;
