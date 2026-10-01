"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import { api, type Status } from "~/lib/api-client";

const POLL_MS = 5000;

/**
 * Shows a loading toast while the server builds the search index after
 * startup. Checks once on load and keeps polling only while that runs.
 */
export function IndexingToast() {
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function check() {
			if (!document.hidden) {
				const { indexing } = await api<Status>("/api/files/status").catch(
					() => ({ indexing: false }),
				);
				if (stopped) return;
				if (!indexing) {
					toast.dismiss("indexing");
					return;
				}
				toast.loading("Indexing in progress…", {
					id: "indexing",
					description: "Search results may be incomplete until it finishes.",
					duration: Number.POSITIVE_INFINITY,
				});
			}
			timer = setTimeout(check, POLL_MS);
		}
		check();
		return () => {
			stopped = true;
			clearTimeout(timer);
			toast.dismiss("indexing");
		};
	}, []);
	return null;
}
