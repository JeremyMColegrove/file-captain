import "~/styles/globals.css";

import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";
import { connection } from "next/server";
import { Suspense } from "react";
import { Toaster } from "~/components/ui/sonner";
import { env } from "~/env";
import { cn } from "~/lib/utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const title = "File Captain";
const description = "Ultra simple file browser";

// Icons and the social card come from icon.tsx, apple-icon.tsx,
// opengraph-image.tsx and twitter-image.tsx. Their URLs must be absolute, so
// metadataBase is read at request time: the Docker image is built without
// knowing the URL it will be served at.
export async function generateMetadata(): Promise<Metadata> {
	await connection();
	return {
		metadataBase: new URL(env.BETTER_AUTH_URL ?? "http://localhost:3000"),
		title,
		description,
		applicationName: title,
		// Private app: keep it out of search results. Link previews still work.
		robots: { index: false, follow: false },
		openGraph: { type: "website", siteName: title, title, description },
		twitter: { card: "summary_large_image", title, description },
	};
}

// Marks every route as intentionally request-time for the metadata above,
// while the rest of each page still prerenders into the static shell.
async function RequestTimeMarker() {
	await connection();
	return null;
}

const geist = Geist({
	subsets: ["latin"],
	variable: "--font-geist-sans",
});

// Lines toasts up with the upload panel (right-4) and keeps them above it
// (--upload-panel-space is set by the panel while it shows).
const toastOffset = {
	right: 16,
	bottom: "calc(var(--upload-panel-space, 0px) + 16px)",
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html className={cn(geist.variable, "font-sans", inter.variable)} lang="en">
			<body>
				{children}
				{/* Bottom-right, stacked above the upload panel while it shows. */}
				<Toaster
					mobileOffset={toastOffset}
					offset={toastOffset}
					position="bottom-right"
				/>
				<Suspense>
					<RequestTimeMarker />
				</Suspense>
			</body>
		</html>
	);
}
