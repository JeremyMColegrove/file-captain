"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";

export function AuthForm() {
	const router = useRouter();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setPending(true);

		const { error } = await authClient.signIn.username({ username, password });

		setPending(false);
		if (error) {
			setError(error.message ?? "Something went wrong. Please try again.");
			return;
		}
		router.push("/");
		router.refresh();
	}

	return (
		<Card className="w-full max-w-sm">
			<CardHeader>
				<CardTitle>Sign in</CardTitle>
				<CardDescription>Enter your username and password.</CardDescription>
			</CardHeader>
			<form onSubmit={onSubmit}>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="username">Username</Label>
						<Input
							autoComplete="username"
							id="username"
							onChange={(e) => setUsername(e.target.value)}
							required
							value={username}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="password">Password</Label>
						<Input
							autoComplete="current-password"
							id="password"
							onChange={(e) => setPassword(e.target.value)}
							required
							type="password"
							value={password}
						/>
					</div>
					{error && <p className="text-destructive text-sm">{error}</p>}
				</CardContent>
				<CardFooter className="mt-4 flex flex-col gap-3 pb-4">
					<Button className="w-full" disabled={pending} type="submit">
						{pending ? "Please wait..." : "Sign in"}
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}
