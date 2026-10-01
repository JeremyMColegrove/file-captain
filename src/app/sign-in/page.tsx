import { ShipIcon } from "lucide-react";

import { AuthForm } from "~/app/_components/auth-form";

export default function Page() {
	return (
		<main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-muted/40 p-4">
			<div className="relative flex w-full max-w-sm flex-col items-center gap-8">
				<div className="flex flex-col items-center gap-3 text-center">
					<div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30 ring-1 ring-primary/20">
						<ShipIcon className="size-6" />
					</div>
					<div className="flex flex-col gap-1">
						<h1 className="font-semibold text-2xl tracking-tight">
							Welcome aboard
						</h1>
						<p className="text-muted-foreground text-sm">
							Sign in to File Captain to access your files.
						</p>
					</div>
				</div>

				<AuthForm />

				<p className="text-muted-foreground text-xs">
					Accounts are managed by your administrator.
				</p>
			</div>
		</main>
	);
}
