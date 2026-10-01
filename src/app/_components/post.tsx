"use client";

import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api } from "~/trpc/react";

export function LatestPost() {
	const [latestPost] = api.post.getLatest.useSuspenseQuery();

	const utils = api.useUtils();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const createPost = api.post.create.useMutation({
		onMutate: async ({ name }) => {
			setError(null);
			setName("");
			await utils.post.getLatest.cancel();
			const previous = utils.post.getLatest.getData();
			utils.post.getLatest.setData(undefined, {
				id: -1,
				name,
				createdById: "",
				createdAt: new Date(),
				updatedAt: null,
			});
			return { previous };
		},
		onError: (err, _input, context) => {
			utils.post.getLatest.setData(undefined, context?.previous);
			setError(err.message);
		},
		onSettled: () => utils.post.invalidate(),
	});

	return (
		<div className="flex w-full max-w-xs flex-col gap-2">
			{latestPost ? (
				<p className="truncate">Your most recent post: {latestPost.name}</p>
			) : (
				<p>You have no posts yet.</p>
			)}
			<form
				className="flex flex-col gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					createPost.mutate({ name });
				}}
			>
				<Input
					onChange={(e) => setName(e.target.value)}
					placeholder="Title"
					value={name}
				/>
				<Button type="submit">Submit</Button>
				{error && <p className="text-destructive text-sm">{error}</p>}
			</form>
		</div>
	);
}
