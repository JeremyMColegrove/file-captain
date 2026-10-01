import { AuthForm } from "~/app/_components/auth-form";

export default function Page() {
	return (
		<main className="flex min-h-screen items-center justify-center p-4">
			<AuthForm mode="sign-in" />
		</main>
	);
}
