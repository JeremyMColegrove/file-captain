import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";

import {
	FileBrowser,
	FolderLinks,
	FolderLinksSkeleton,
	FolderView,
	FolderViewError,
	FolderViewSkeleton,
} from "~/app/_components/file-browser";
import { SidebarProvider } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { pathQuery } from "~/lib/schemas";
import { requirePageUser } from "~/server/better-auth/server";
import { toAppError } from "~/server/errors";
import * as fileService from "~/server/file-service";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The shell is prerendered. The user's name, their folders and the open
 * folder each stream in behind their own Suspense boundary, so none waits
 * for another.
 */
export default function Home({ searchParams }: { searchParams: SearchParams }) {
	return (
		<SidebarProvider>
			<FileBrowser
				account={
					<Suspense fallback={<Skeleton className="h-4 w-24" />}>
						<Account />
					</Suspense>
				}
				folders={
					<Suspense fallback={<FolderLinksSkeleton />}>
						<Folders />
					</Suspense>
				}
			>
				<Suspense fallback={<FolderViewSkeleton />}>
					<Folder searchParams={searchParams} />
				</Suspense>
			</FileBrowser>
		</SidebarProvider>
	);
}

async function Account() {
	const user = await requirePageUser();
	return (
		<span className="truncate text-muted-foreground text-sm">
			{user.username}
		</span>
	);
}

async function Folders() {
	const user = await requirePageUser();
	try {
		const { entries } = await fileService.list(user, "/");
		return <FolderLinks folders={entries} />;
	} catch (err) {
		return <p className="px-2 text-destructive text-sm">{errorMessage(err)}</p>;
	}
}

async function Folder({ searchParams }: { searchParams: SearchParams }) {
	const user = await requirePageUser();
	try {
		let { path } = pathQuery.parse(await searchParams);
		let listing = await fileService.list(user, path);
		// "/" only lists the folders; show the first one instead, so the
		// breadcrumbs always start at a folder.
		const first = listing.entries[0];
		if (path === "/" && first) {
			path = `/${first.name}`;
			listing = await fileService.list(user, path);
		}
		return (
			<FolderView listing={listing} path={path} readOnly={user.readOnly} />
		);
	} catch (err) {
		return <FolderViewError message={errorMessage(err)} />;
	}
}

/** The client-safe message for a failure (never a host path or stack). */
function errorMessage(err: unknown) {
	// Next.js control flow (redirects, dynamic bailouts) must propagate.
	unstable_rethrow(err);
	const appError = toAppError(err);
	if (appError.status >= 500) console.error(err);
	return appError.message;
}
