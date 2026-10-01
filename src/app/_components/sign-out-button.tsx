"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth-client";

export function SignOutButton() {
	const router = useRouter();
	const [pending, setPending] = useState(false);

	return (
		<Button
			disabled={pending}
			onClick={async () => {
				setPending(true);
				const { error } = await authClient.signOut();
				if (error) {
					setPending(false);
					toast.error("Sign out failed", {
						description:
							error.message ?? "Something went wrong. Please try again.",
					});
					return;
				}
				// Stays pending until the sign-in page replaces this one.
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
