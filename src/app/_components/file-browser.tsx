"use client";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
	CircleAlertIcon,
	ClipboardPasteIcon,
	CopyIcon,
	DownloadIcon,
	FileIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	type LucideIcon,
	PencilIcon,
	ScissorsIcon,
	SearchIcon,
	ShipIcon,
	Trash2Icon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "~/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSkeleton,
	SidebarTrigger,
} from "~/components/ui/sidebar";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import {
	api,
	type Entry,
	join,
	type Listing,
	q,
	type SearchResult,
} from "~/lib/api-client";
import { cn } from "~/lib/utils";
import { SignOutButton } from "./sign-out-button";
import { Uploader } from "./uploader";

type Action = "mkdir" | "rename" | "delete";
/** An entry marked with Copy or Cut, waiting to be pasted into another folder. */
type Clip = { mode: "copy" | "cut"; src: string; name: string };
/** One action on the selected entry, shown in the toolbar and the context menu. */
type EntryAction = {
	label: string;
	icon: LucideIcon;
	run: () => void;
	destructive?: boolean;
};

function formatSize(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function sortEntries(entries: Entry[]) {
	return [...entries].sort((a, b) =>
		a.type === b.type
			? a.name.localeCompare(b.name, undefined, { numeric: true })
			: a.type === "dir"
				? -1
				: 1,
	);
}

/** Finder-style name for a copy in the same folder: "a copy.txt", "a copy 2.txt", … */
function copyName(name: string, taken: string[]) {
	const dot = name.lastIndexOf(".");
	const [base, ext] =
		dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let n = 1; ; n++) {
		const candidate = `${base} copy${n === 1 ? "" : ` ${n}`}${ext}`;
		const lower = candidate.toLowerCase();
		if (!taken.some((t) => t.toLowerCase() === lower)) return candidate;
	}
}

export function FileBrowser({
	username,
	readOnly,
}: {
	username: string;
	/** The user can't write anywhere, so copying is pointless too. */
	readOnly: boolean;
}) {
	const router = useRouter();
	const path = useSearchParams().get("path") || "/";
	const segments = path.split("/").filter(Boolean);
	const [folders, setFolders] = useState<Entry[] | null>(null);
	const [listing, setListing] = useState<Listing | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	// A server-side failure, shown as a floating alert so nothing shifts.
	const [actionError, setActionError] = useState<{
		title: string;
		message: string;
	} | null>(null);

	// The open action dialog, and its input/pending/error state.
	const [dialog, setDialog] = useState<{
		action: Action;
		entry?: Entry;
	} | null>(null);
	const [value, setValue] = useState("");
	const [pending, setPending] = useState(false);

	// The highlighted entry (by name, within `path`) and the Copy/Cut clipboard.
	const [selected, setSelected] = useState<{
		path: string;
		name: string;
	} | null>(null);
	const [clip, setClip] = useState<Clip | null>(null);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const select = (name: string | null) =>
		setSelected(name === null ? null : { path, name });

	// Escape, or a click anywhere except a row or the selection's action
	// buttons, clears the selection.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setSelected(null);
			// Cmd/Ctrl+F searches all folders instead of the browser's find.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				setSearchOpen(true);
			}
		};
		const onClick = (e: MouseEvent) => {
			const target = e.target as Element;
			if (!target.closest("tr[data-name], [data-keep-selection]")) {
				setSelected(null);
			}
		};
		window.addEventListener("keydown", onKey);
		document.addEventListener("click", onClick);
		return () => {
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("click", onClick);
		};
	}, []);

	// Also reloaded after each change, to keep the usage bars current.
	const loadFolders = useCallback(async () => {
		try {
			setFolders((await api<Listing>(`/api/files${q("/")}`)).entries);
		} catch {
			setFolders((prev) => prev ?? []);
		}
	}, []);

	useEffect(() => {
		void loadFolders();
	}, [loadFolders]);

	// "/" is only a list of the configured folders; open the first one instead,
	// so the breadcrumbs always start at a folder.
	useEffect(() => {
		if (path === "/" && folders?.[0]) {
			router.replace(q(`/${folders[0].name}`));
		}
	}, [path, folders, router]);

	const refresh = useCallback(async () => {
		try {
			setListing(await api<Listing>(`/api/files${q(path)}`));
			setLoadError(null);
		} catch (err) {
			setListing(null);
			setLoadError((err as Error).message);
		}
	}, [path]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	function open(action: Action, entry?: Entry) {
		setDialog({ action, entry });
		setValue(action === "rename" ? (entry?.name ?? "") : "");
		setActionError(null);
		setPending(false);
	}

	const name = dialog?.entry?.name ?? "";
	const src = join(path, name);
	const kind = dialog?.entry?.type === "dir" ? "folder" : "file";
	const dialogs: Record<
		Action,
		{
			title: string;
			description: string;
			confirm: string;
			input: boolean;
			run: () => Promise<unknown>;
		}
	> = {
		mkdir: {
			title: "New folder",
			description: `Create a folder in ${path}.`,
			confirm: "Create",
			input: true,
			run: () => api("/api/files/mkdir", { path: join(path, value) }),
		},
		rename: {
			title: `Rename ${kind}`,
			description: `Enter a new name for "${name}".`,
			confirm: "Rename",
			input: true,
			run: () => api("/api/files/rename", { path: src, newName: value }),
		},
		delete: {
			title: `Delete ${kind}?`,
			description:
				kind === "folder"
					? `"${name}" and everything in it will be permanently deleted.`
					: `"${name}" will be permanently deleted.`,
			confirm: "Delete",
			input: false,
			run: () => api("/api/files/delete", { path: src }),
		},
	};
	const current = dialog ? dialogs[dialog.action] : null;

	// Why the typed name can't be used: "" disables the button silently (empty
	// or unchanged), a message also explains it. Checked before submitting so
	// predictable failures never reach the server.
	// Names compare case-insensitively, since some disks (e.g. macOS) treat
	// "Photo.jpg" and "photo.jpg" as the same file.
	const trimmed = value.trim();
	const lower = trimmed.toLowerCase();
	const nameProblem = !current?.input
		? null
		: !trimmed || (dialog?.action === "rename" && lower === name.toLowerCase())
			? ""
			: listing?.entries.some((entry) => entry.name.toLowerCase() === lower)
				? "An item with that name already exists."
				: null;

	async function confirm(e: React.FormEvent) {
		e.preventDefault();
		if (!current || nameProblem !== null) return;
		setPending(true);
		try {
			await current.run();
			if (dialog?.action === "rename" || dialog?.action === "mkdir") {
				select(value);
			}
			setDialog(null);
			await Promise.all([refresh(), loadFolders()]);
		} catch (err) {
			// Keep the dialog open so the user can fix the name and retry.
			setActionError({
				title: `${current.confirm} failed`,
				message: (err as Error).message,
			});
		}
		setPending(false);
	}

	const writable = listing?.writable ?? false;
	const selectedEntry =
		selected?.path === path
			? (listing?.entries.find((entry) => entry.name === selected.name) ?? null)
			: null;
	// Top-level folders come from config and can't be changed, and nothing can
	// be pasted into the virtual root.
	const canPaste = clip !== null && writable && path !== "/";

	function openEntry(entry: Entry) {
		const entryPath = join(path, entry.name);
		if (entry.type === "dir") router.push(q(entryPath));
		else window.location.href = `/api/files/download${q(entryPath)}`;
	}

	/** Opens a folder result, or shows a file result selected in its folder. */
	function openResult(result: SearchResult) {
		if (result.type === "dir") return router.push(q(result.path));
		const parent = result.path.slice(0, result.path.lastIndexOf("/"));
		setSelected({ path: parent, name: result.name });
		router.push(q(parent));
	}

	async function paste() {
		if (!clip) return;
		setActionError(null);
		let name = clip.name;
		if (join(path, name) === clip.src) {
			// Cutting and pasting into the same folder changes nothing.
			if (clip.mode === "cut") return setClip(null);
			name = copyName(name, listing?.entries.map((e) => e.name) ?? []);
		}
		const dst = join(path, name);
		try {
			if (clip.mode === "cut") {
				await api("/api/files/move", { src: clip.src, dst });
				setClip(null);
			} else {
				await api("/api/files/copy", { src: clip.src, dst });
			}
			select(name);
		} catch (err) {
			setActionError({
				title: "Paste failed",
				message: (err as Error).message,
			});
		}
		await Promise.all([refresh(), loadFolders()]);
	}

	function actionsFor(entry: Entry): EntryAction[] {
		const isDir = entry.type === "dir";
		const actions: EntryAction[] = [
			{
				label: isDir ? "Open" : "Download",
				icon: isDir ? FolderOpenIcon : DownloadIcon,
				run: () => openEntry(entry),
			},
		];
		if (path === "/") return actions;
		const src = join(path, entry.name);
		if (!readOnly) {
			actions.push({
				label: "Copy",
				icon: CopyIcon,
				run: () => setClip({ mode: "copy", src, name: entry.name }),
			});
		}
		if (writable) {
			actions.push({
				label: "Cut",
				icon: ScissorsIcon,
				run: () => setClip({ mode: "cut", src, name: entry.name }),
			});
		}
		if (writable) {
			actions.push(
				{
					label: "Rename",
					icon: PencilIcon,
					run: () => open("rename", entry),
				},
				{
					label: "Delete",
					icon: Trash2Icon,
					run: () => open("delete", entry),
					destructive: true,
				},
			);
		}
		return actions;
	}

	return (
		<>
			<Sidebar>
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton render={<Link href="/" />} size="lg">
								<ShipIcon />
								<span className="font-semibold">File Captain</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Folders</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{folders === null &&
									[0, 1, 2].map((i) => (
										<SidebarMenuItem key={i}>
											<SidebarMenuSkeleton showIcon />
										</SidebarMenuItem>
									))}
								{folders?.map((folder) => (
									<SidebarMenuItem key={folder.name}>
										<SidebarMenuButton
											className="data-active:bg-blue-200 data-active:hover:bg-blue-200 dark:data-active:bg-blue-900 dark:data-active:hover:bg-blue-900"
											isActive={folder.name === segments[0]}
											render={<Link href={q(`/${folder.name}`)} />}
										>
											<FolderIcon />
											<span>{folder.name}</span>
										</SidebarMenuButton>
										{folder.limit !== undefined && (
											<FolderUsage limit={folder.limit} used={folder.size} />
										)}
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<div className="flex items-center justify-between gap-2 px-2">
						<span className="truncate text-muted-foreground text-sm">
							{username}
						</span>
						<SignOutButton />
					</div>
				</SidebarFooter>
			</Sidebar>

			<SidebarInset>
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger className="-ml-1" />
					<Breadcrumb className="min-w-0 flex-1">
						<BreadcrumbList>
							{segments.map((segment, i) => {
								const href = `/${segments.slice(0, i + 1).join("/")}`;
								return (
									<Fragment key={href}>
										{i > 0 && <BreadcrumbSeparator />}
										<BreadcrumbItem>
											{i === segments.length - 1 ? (
												<BreadcrumbPage>{segment}</BreadcrumbPage>
											) : (
												<BreadcrumbLink render={<Link href={q(href)} />}>
													{segment}
												</BreadcrumbLink>
											)}
										</BreadcrumbItem>
									</Fragment>
								);
							})}
						</BreadcrumbList>
					</Breadcrumb>
					<div className="flex gap-2">
						<Button
							onClick={() => setSearchOpen(true)}
							size="icon"
							title="Search (⌘F / Ctrl+F)"
							variant="ghost"
						>
							<SearchIcon />
							<span className="sr-only">Search</span>
						</Button>
						{writable && (
							<Button onClick={() => open("mkdir")} variant="outline">
								<FolderPlusIcon />
								New folder
							</Button>
						)}
						<Uploader
							dir={path}
							onOpenChange={setUploadOpen}
							onUploaded={() => void Promise.all([refresh(), loadFolders()])}
							open={uploadOpen}
							showButton={writable}
						/>
					</div>
				</header>

				<ContextMenu>
					<ContextMenuTrigger
						className="flex flex-1 select-auto flex-col gap-4 p-4"
						onContextMenu={(e) => {
							// Right-click selects the row under the cursor, or clears the
							// selection on empty space so the menu offers folder actions.
							const row = (e.target as Element).closest("tr[data-name]");
							select(row?.getAttribute("data-name") ?? null);
						}}
					>
						{loadError && (
							<Alert variant="destructive">
								<CircleAlertIcon />
								<AlertTitle>Could not open folder</AlertTitle>
								<AlertDescription>{loadError}</AlertDescription>
							</Alert>
						)}

						{listing && (
							<FileTable
								entries={listing.entries}
								onOpen={openEntry}
								onSelect={select}
								path={path}
								selected={selectedEntry?.name ?? null}
							/>
						)}
					</ContextMenuTrigger>
					<ContextMenuContent data-keep-selection>
						{selectedEntry ? (
							actionsFor(selectedEntry).map((action) => (
								<Fragment key={action.label}>
									{action.destructive && <ContextMenuSeparator />}
									<ContextMenuItem
										onClick={action.run}
										variant={action.destructive ? "destructive" : "default"}
									>
										<action.icon />
										{action.label}
									</ContextMenuItem>
								</Fragment>
							))
						) : (
							<>
								<ContextMenuItem disabled={!canPaste} onClick={paste}>
									<ClipboardPasteIcon />
									{clip ? `Paste "${clip.name}"` : "Paste"}
								</ContextMenuItem>
								<ContextMenuItem
									disabled={!writable}
									onClick={() => open("mkdir")}
								>
									<FolderPlusIcon />
									New folder
								</ContextMenuItem>
								<ContextMenuItem
									disabled={!writable}
									onClick={() => setUploadOpen(true)}
								>
									<UploadIcon />
									Upload
								</ContextMenuItem>
							</>
						)}
					</ContextMenuContent>
				</ContextMenu>
			</SidebarInset>

			{/* Portaled above everything, including an open dialog's backdrop. */}
			{actionError &&
				createPortal(
					<Alert
						className="fixed right-4 bottom-4 z-100 w-auto max-w-sm shadow-lg"
						variant="destructive"
					>
						<CircleAlertIcon />
						<AlertTitle>{actionError.title}</AlertTitle>
						<AlertDescription>{actionError.message}</AlertDescription>
						<AlertAction>
							<Button
								onClick={() => setActionError(null)}
								size="icon-xs"
								variant="ghost"
							>
								<XIcon />
								<span className="sr-only">Dismiss</span>
							</Button>
						</AlertAction>
					</Alert>,
					document.body,
				)}

			<Dialog onOpenChange={setSearchOpen} open={searchOpen}>
				<DialogContent
					className="top-[15%] translate-y-0 gap-0 p-0 sm:max-w-xl"
					showCloseButton={false}
				>
					<DialogTitle className="sr-only">Search</DialogTitle>
					{/* Rendered only while open, so each search starts empty. */}
					<SearchPanel
						onOpen={(result) => {
							setSearchOpen(false);
							openResult(result);
						}}
					/>
				</DialogContent>
			</Dialog>

			<AlertDialog
				onOpenChange={(isOpen) => {
					if (!isOpen && !pending) setDialog(null);
				}}
				open={dialog !== null}
			>
				<AlertDialogContent>
					{current && (
						<form className="contents" onSubmit={confirm}>
							<AlertDialogHeader>
								<AlertDialogTitle>{current.title}</AlertDialogTitle>
								<AlertDialogDescription>
									{current.description}
								</AlertDialogDescription>
							</AlertDialogHeader>
							{current.input && (
								<Input
									autoFocus
									disabled={pending}
									onChange={(e) => {
										setValue(e.target.value);
										setActionError(null);
									}}
									value={value}
								/>
							)}
							{/* Space is reserved so the message doesn't shift the layout. */}

							<AlertDialogFooter>
								<AlertDialogCancel disabled={pending} type="button">
									Cancel
								</AlertDialogCancel>
								<AlertDialogAction
									disabled={pending || nameProblem !== null}
									type="submit"
									variant={
										dialog?.action === "delete" ? "destructive" : "default"
									}
								>
									{pending ? "Working…" : current.confirm}
								</AlertDialogAction>
							</AlertDialogFooter>
						</form>
					)}
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/**
 * The folder listing. Only the rows in view are rendered, with spacer rows
 * standing in for the rest, so folders with thousands of entries stay fast.
 */
function FileTable({
	path,
	entries,
	selected,
	onSelect,
	onOpen,
}: {
	path: string;
	entries: Entry[];
	selected: string | null;
	onSelect: (name: string) => void;
	onOpen: (entry: Entry) => void;
}) {
	const rows = useMemo(() => sortEntries(entries), [entries]);
	const tableRef = useRef<HTMLTableElement>(null);
	// Where the table starts on the page; the window is what scrolls.
	const [scrollMargin, setScrollMargin] = useState(0);
	useLayoutEffect(() => {
		const top = tableRef.current?.getBoundingClientRect().top ?? 0;
		setScrollMargin(top + window.scrollY);
	}, []);

	const virtualizer = useWindowVirtualizer({
		count: rows.length,
		estimateSize: () => 49, // 32px icon + padding + border
		overscan: 10,
		scrollMargin,
	});

	// Brings the selected entry into view when a listing loads with one
	// already selected, e.g. after opening a search result.
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	useEffect(() => {
		const index = rows.findIndex((e) => e.name === selectedRef.current);
		if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
	}, [rows, virtualizer]);

	const items = virtualizer.getVirtualItems();
	const first = items[0];
	const last = items[items.length - 1];
	const padTop = first ? first.start - scrollMargin : 0;
	const padBottom = last ? virtualizer.getTotalSize() - last.end : 0;

	return (
		<Table className="table-fixed" ref={tableRef}>
			<TableHeader>
				<TableRow>
					<TableHead>Name</TableHead>
					<TableHead className="hidden w-24 text-right sm:table-cell">
						Size
					</TableHead>
					<TableHead className="hidden w-48 md:table-cell">Modified</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.length === 0 && (
					<TableRow className="hover:bg-transparent">
						<TableCell
							className="h-24 text-center text-muted-foreground"
							colSpan={3}
						>
							This folder is empty
						</TableCell>
					</TableRow>
				)}
				{padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
				{items.map((item) => {
					const entry = rows[item.index];
					if (!entry) return null;
					return (
						<TableRow
							className="cursor-pointer select-none data-[state=selected]:bg-blue-200 data-[state=selected]:hover:bg-blue-200 dark:data-[state=selected]:bg-blue-900 dark:data-[state=selected]:hover:bg-blue-900"
							data-index={item.index}
							data-name={entry.name}
							data-state={entry.name === selected ? "selected" : undefined}
							key={entry.name}
							onClick={() => onSelect(entry.name)}
							onDoubleClick={() => onOpen(entry)}
							ref={virtualizer.measureElement}
						>
							<TableCell>
								<div className="flex items-center gap-3 font-medium">
									<EntryIcon entry={entry} path={join(path, entry.name)} />
									<span className="truncate">{entry.name}</span>
								</div>
							</TableCell>
							<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
								{entry.type === "file" ? formatSize(entry.size) : ""}
							</TableCell>
							<TableCell className="hidden text-muted-foreground md:table-cell">
								{new Date(entry.mtime).toLocaleString()}
							</TableCell>
						</TableRow>
					);
				})}
				{padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
			</TableBody>
		</Table>
	);
}

/** A compact bar under a folder in the sidebar: how much of its storageLimit is used. */
function FolderUsage({ used, limit }: { used: number; limit: number }) {
	const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
	return (
		<div
			className="px-2 pb-1.5"
			title={`${formatSize(used)} of ${formatSize(limit)} used`}
		>
			<div className="h-1 overflow-hidden rounded-full bg-muted">
				<div
					className={cn(
						"h-full rounded-full",
						percent >= 90 ? "bg-destructive" : "bg-primary",
					)}
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}

/** Search across all folders: an input with the matches listed below it. */
function SearchPanel({ onOpen }: { onOpen: (result: SearchResult) => void }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResult[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The result picked with the arrow keys.
	const [active, setActive] = useState(0);
	const term = query.trim();

	// Waits for a pause in typing, and ignores answers to older queries.
	useEffect(() => {
		if (!term) {
			setResults(null);
			setError(null);
			return;
		}
		let stale = false;
		const timer = setTimeout(() => {
			api<{ results: SearchResult[] }>(
				`/api/files/search?q=${encodeURIComponent(term)}`,
			)
				.then((data) => {
					if (stale) return;
					setResults(data.results);
					setError(null);
					setActive(0);
				})
				.catch((err: Error) => {
					if (!stale) setError(err.message);
				});
		}, 200);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [term]);

	function onKeyDown(e: React.KeyboardEvent) {
		const count = results?.length ?? 0;
		if (e.key === "ArrowDown" && count) {
			e.preventDefault();
			setActive((i) => (i + 1) % count);
		} else if (e.key === "ArrowUp" && count) {
			e.preventDefault();
			setActive((i) => (i - 1 + count) % count);
		} else if (e.key === "Enter") {
			const result = results?.[active];
			if (term && result) onOpen(result);
		}
	}

	return (
		<>
			<div className="relative border-b">
				<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					aria-label="Search files"
					autoFocus
					className="h-11 rounded-none border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search files and folders"
					type="search"
					value={query}
				/>
			</div>
			{term && (
				<div className="max-h-[60vh] overflow-y-auto p-1">
					{error ? (
						<p className="px-3 py-2 text-destructive text-sm">{error}</p>
					) : results === null ? (
						<p className="px-3 py-2 text-muted-foreground text-sm">
							Searching…
						</p>
					) : results.length === 0 ? (
						<p className="px-3 py-2 text-muted-foreground text-sm">
							No matches
						</p>
					) : (
						results.map((result, i) => (
							<button
								className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left data-active:bg-accent data-active:text-accent-foreground"
								data-active={i === active ? "" : undefined}
								// Keeps the selection that opening a file result makes.
								data-keep-selection
								key={result.path}
								onClick={() => onOpen(result)}
								onMouseMove={() => setActive(i)}
								type="button"
							>
								<EntryIcon entry={result} path={result.path} />
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium text-sm">
										{result.name}
									</div>
									<div className="truncate text-muted-foreground text-xs">
										{result.path.slice(0, result.path.lastIndexOf("/"))}
									</div>
								</div>
								{result.type === "file" && (
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										{formatSize(result.size)}
									</span>
								)}
							</button>
						))
					)}
				</div>
			)}
		</>
	);
}

function EntryIcon({ entry, path }: { entry: Entry; path: string }) {
	const [failed, setFailed] = useState(false);
	if (entry.type === "dir") {
		return <FolderIcon className="size-8 shrink-0 p-1 text-muted-foreground" />;
	}
	if (!entry.thumbnail || failed) {
		return <FileIcon className="size-8 shrink-0 p-1 text-muted-foreground" />;
	}
	// `v` changes with the file, so the long-lived browser cache stays correct.
	return (
		// biome-ignore lint/performance/noImgElement: thumbnails are already sized webp from our API
		<img
			alt=""
			className="size-8 shrink-0 rounded-sm object-cover"
			loading="lazy"
			onError={() => setFailed(true)}
			src={`/api/files/thumbnail${q(path)}&v=${encodeURIComponent(`${entry.mtime}-${entry.size}`)}`}
		/>
	);
}
