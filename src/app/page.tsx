import { redirect } from "next/navigation";
import { Suspense } from "react";

import { FileBrowser } from "~/app/_components/file-browser";
import { SidebarProvider } from "~/components/ui/sidebar";
import { getSession } from "~/server/better-auth/server";
import { findUser } from "~/server/config";

export default function Home() {
	return (
		<Suspense
			fallback={<p className="p-4 text-muted-foreground">Loading...</p>}
		>
			<SignedInContent />
		</Suspense>
	);
}

async function SignedInContent() {
	const session = await getSession();
	if (!session) redirect("/sign-in");

	return (
		<SidebarProvider>
			<FileBrowser
				// A UI hint only; file-service enforces read-only on every write.
				readOnly={findUser(session.user.username ?? "")?.readOnly ?? true}
				username={session.user.displayUsername ?? session.user.name}
			/>
		</SidebarProvider>
	);
}
