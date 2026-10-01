"use client";

import {
	CircleAlertIcon,
	EyeIcon,
	EyeOffIcon,
	Loader2Icon,
	LockIcon,
	MailIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";

export function AuthForm() {
	const router = useRouter();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setPending(true);

		const { error } = await authClient.signIn.username({ username, password });

		if (error) {
			setPending(false);
			setError(error.message ?? "Something went wrong. Please try again.");
			return;
		}
		// Stays pending until the next page replaces this one.
		router.push("/");
		router.refresh();
	}

	return (
		<Card className="w-full shadow-black/5 shadow-xl">
			<form onSubmit={onSubmit}>
				<CardContent className="flex flex-col gap-5">
					<div className="flex flex-col gap-2">
						<Label htmlFor="username">Email</Label>
						<div className="relative">
							<MailIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								aria-invalid={error ? true : undefined}
								autoComplete="username"
								autoFocus
								className="h-10 pl-9"
								disabled={pending}
								id="username"
								onChange={(e) => setUsername(e.target.value)}
								required
								type="email"
								value={username}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="password">Password</Label>
						<div className="relative">
							<LockIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								aria-invalid={error ? true : undefined}
								autoComplete="current-password"
								className="h-10 pr-10 pl-9"
								disabled={pending}
								id="password"
								onChange={(e) => setPassword(e.target.value)}
								required
								type={showPassword ? "text" : "password"}
								value={password}
							/>
							<button
								aria-label={showPassword ? "Hide password" : "Show password"}
								className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
								onClick={() => setShowPassword((s) => !s)}
								type="button"
							>
								{showPassword ? (
									<EyeOffIcon className="size-4" />
								) : (
									<EyeIcon className="size-4" />
								)}
							</button>
						</div>
					</div>

					{/* Space is reserved so an error doesn't resize the card. */}
					<div className="-my-1 min-h-5" role="alert">
						{error && (
							<p className="flex items-center gap-1.5 text-destructive text-sm">
								<CircleAlertIcon className="size-4 shrink-0" />
								{error}
							</p>
						)}
					</div>

					<Button className="h-10 w-full" disabled={pending} type="submit">
						{pending && <Loader2Icon className="size-4 animate-spin" />}
						{pending ? "Signing in…" : "Sign in"}
					</Button>
				</CardContent>
			</form>
		</Card>
	);
}
