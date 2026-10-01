import { redirect } from "next/navigation";
import { Suspense } from "react";

import { LatestPost } from "~/app/_components/post";
import { SignOutButton } from "~/app/_components/sign-out-button";
import { getSession } from "~/server/better-auth/server";
import { api, HydrateClient } from "~/trpc/server";

export default function Home() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-8 p-4">
			<h1 className="font-bold text-3xl tracking-tight">File Captain</h1>
			<Suspense fallback={<p className="text-muted-foreground">Loading...</p>}>
				<SignedInContent />
			</Suspense>
		</main>
	);
}

async function SignedInContent() {
	const session = await getSession();
	if (!session) redirect("/sign-in");

	void api.post.getLatest.prefetch();

	return (
		<HydrateClient>
			<div className="flex flex-col items-center gap-4">
				<p>
					Signed in as{" "}
					<span className="font-semibold">
						{session.user.displayUsername ?? session.user.name}
					</span>
				</p>
				<SignOutButton />
				<LatestPost />
			</div>
		</HydrateClient>
	);
}
