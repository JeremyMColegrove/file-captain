/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
	output: "standalone",
	// Lets pages prerender a static shell (e.g. the dashboard skeletons) while
	// deferring anything behind a Suspense boundary that reads per-request data
	// (headers/cookies/auth) to render dynamically at request time instead of
	// forcing the whole page to skip static generation.
	cacheComponents: true,
};

export default config;
