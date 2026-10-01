"use client";

import { useRouter } from "next/navigation";

import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth-client";

export function SignOutButton() {
	const router = useRouter();

	return (
		<Button
			onClick={async () => {
				await authClient.signOut();
				router.push("/sign-in");
				router.refresh();
			}}
			size="sm"
			variant="ghost"
		>
			Sign out
		</Button>
	);
}
