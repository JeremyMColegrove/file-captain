"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth-client";
import { type Message, MessageDialog } from "./message-dialog";

export function SignOutButton() {
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<Message | null>(null);

	return (
		<>
			<Button
				disabled={pending}
				onClick={async () => {
					setPending(true);
					const { error } = await authClient.signOut();
					if (error) {
						setPending(false);
						setError({
							title: "Sign out failed",
							message:
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
			<MessageDialog message={error} onClose={() => setError(null)} />
		</>
	);
}
