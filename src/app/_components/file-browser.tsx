"use client";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
	CircleAlertIcon,
	ClipboardPasteIcon,
	CopyIcon,
	DownloadIcon,
	EyeIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	KeyboardIcon,
	Loader2Icon,
	type LucideIcon,
	PencilIcon,
	ScissorsIcon,
	SearchIcon,
	ShipIcon,
	Trash2Icon,
	UploadIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	createContext,
	Fragment,
	use,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
import { Skeleton } from "~/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import {
	ApiError,
	api,
	type Entry,
	join,
	type Listing,
	q,
	type SearchResult,
	thumbnailUrl,
} from "~/lib/api-client";
import { formatShortDate, formatSize } from "~/lib/format";
import { cn } from "~/lib/utils";
import { FilePreview } from "./file-preview";
import { IndexingToast } from "./indexing-toast";
import { SignOutButton } from "./sign-out-button";
import { TypeIcon } from "./type-icon";
import { Uploader } from "./uploader";

type Action = "mkdir" | "rename" | "delete";
/** Entries of one folder marked with Copy or Cut, waiting to be pasted. */
type Clip = { mode: "copy" | "cut"; dir: string; names: string[] };
/**
 * The highlighted entries, by name within the folder at `path`. `anchor` is
 * the last plainly clicked one, where a Shift-click range starts; `lead` is
 * the one the arrow keys move from.
 */
type Selection = {
	path: string;
	names: string[];
	anchor: string;
	lead: string;
};
/** One action on the selected entry, shown in the context menu. */
type EntryAction = {
	label: string;
	icon: LucideIcon;
	run: () => void;
	destructive?: boolean;
};

// One collator for every comparison: localeCompare with options builds a new
// one per call, which makes sorting big folders slow.
const nameOrder = new Intl.Collator(undefined, { numeric: true });

/** The names from `a` to `b` (either order), inclusive. */
function rangeOf(rows: Entry[], a: string, b: string) {
	const from = rows.findIndex((r) => r.name === a);
	const to = rows.findIndex((r) => r.name === b);
	return rows
		.slice(Math.min(from, to), Math.max(from, to) + 1)
		.map((r) => r.name);
}

/**
 * Whether a key press belongs to what has focus (a field, dialog or menu)
 * rather than to the page's shortcuts.
 */
function isForFocused(e: KeyboardEvent) {
	const target = e.target as Element;
	if (
		target.closest(
			"input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog], [role=menu]",
		)
	) {
		return true;
	}
	// Enter and Space activate a focused button or link.
	return (e.key === "Enter" || e.key === " ") && !!target.closest("button, a");
}

function sortEntries(entries: Entry[]) {
	return [...entries].sort((a, b) =>
		a.type === b.type
			? nameOrder.compare(a.name, b.name)
			: a.type === "dir"
				? -1
				: 1,
	);
}

/** `"a.jpg"` for one name, `3 items` for several. */
function describe(names: string[]) {
	return names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
}

/**
 * Starts a download without leaving the page. The request loads in a hidden
 * iframe: a file arrives as a download and the iframe stays blank, while an
 * error loads there as a page whose message is shown in a toast (navigating
 * the window itself would replace the app with the error's JSON).
 */
function startDownload(
	method: "GET" | "POST",
	action: string,
	fields: [string, string][],
) {
	const frame = document.createElement("iframe");
	frame.name = `download-${crypto.randomUUID()}`;
	frame.hidden = true;
	document.body.append(frame);
	frame.addEventListener("load", () => {
		let message = "The file may have been moved or deleted.";
		try {
			// Some browsers fire load for the initial blank page too.
			if (frame.contentWindow?.location.href === "about:blank") return;
			const doc = frame.contentDocument;
			const text = (doc?.querySelector("pre") ?? doc?.body)?.textContent;
			message = JSON.parse(text ?? "").error.message ?? message;
		} catch {
			// Not our JSON error (or not readable): keep the generic message.
		}
		toast.error("Download failed", { description: message });
		frame.remove();
	});
	// A started download doesn't need the iframe; remove it eventually.
	setTimeout(() => frame.remove(), 10 * 60 * 1000);

	const form = document.createElement("form");
	form.method = method;
	form.action = action;
	form.target = frame.name;
	for (const [name, value] of fields) {
		const input = document.createElement("input");
		input.type = "hidden";
		input.name = name;
		input.value = value;
		form.append(input);
	}
	document.body.append(form);
	form.submit();
	form.remove();
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

/**
 * State that outlives a single folder view: the selection, the clipboard,
 * navigation, and the search and upload dialogs.
 */
type Shell = {
	selected: Selection | null;
	setSelected: (selection: Selection | null) => void;
	clip: Clip | null;
	setClip: (clip: Clip | null) => void;
	/** True while a navigation or refresh is loading. */
	pending: boolean;
	navigate: (href: string) => void;
	/** Re-renders the page on the server, e.g. after a change. */
	refresh: () => void;
	openSearch: () => void;
	openShortcuts: () => void;
	openUpload: (dir: string) => void;
	/** Where files dropped on the page go; null disables dropping. */
	setDropDir: (dir: string | null) => void;
	uploading: boolean;
};

const ShellContext = createContext<Shell | null>(null);

function useShell() {
	const shell = use(ShellContext);
	if (!shell) throw new Error("useShell must be used inside FileBrowser");
	return shell;
}

/**
 * The page shell. Everything here is prerendered; the parts that need the
 * user (`account`, `folders` and `children`, the folder view) stream in from
 * the server behind their own Suspense boundaries.
 */
export function FileBrowser({
	account,
	folders,
	children,
}: {
	account: React.ReactNode;
	folders: React.ReactNode;
	children: React.ReactNode;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [selected, setSelected] = useState<Selection | null>(null);
	const [clip, setClip] = useState<Clip | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [upload, setUpload] = useState({ open: false, dir: "/" });
	const [uploading, setUploading] = useState(false);
	const [dropDir, setDropDir] = useState<string | null>(null);

	// Escape, or a click anywhere except a row or a dialog that keeps it,
	// clears the selection.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !isForFocused(e)) setSelected(null);
			// Cmd/Ctrl+F searches all folders instead of the browser's find,
			// except in a dialog (e.g. a text preview), where find is useful.
			if (
				(e.metaKey || e.ctrlKey) &&
				e.key.toLowerCase() === "f" &&
				!(e.target as Element).closest("[role=dialog], [role=alertdialog]")
			) {
				e.preventDefault();
				setSearchOpen(true);
			}
			if (e.key === "?" && !isForFocused(e)) setShortcutsOpen(true);
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

	// The old folder stays on screen, dimmed, until the new one has loaded.
	const navigate = (href: string) => startTransition(() => router.push(href));
	const refresh = () => startTransition(() => router.refresh());

	const shell: Shell = {
		selected,
		setSelected,
		clip,
		setClip,
		pending,
		navigate,
		refresh,
		openSearch: () => setSearchOpen(true),
		openShortcuts: () => setShortcutsOpen(true),
		openUpload: (dir) => setUpload({ open: true, dir }),
		setDropDir,
		uploading,
	};

	/** Opens a folder result, or shows a file result selected in its folder. */
	function openResult(result: SearchResult) {
		if (result.type === "dir") return navigate(q(result.path));
		const parent = result.path.slice(0, result.path.lastIndexOf("/"));
		setSelected({
			path: parent,
			names: [result.name],
			anchor: result.name,
			lead: result.name,
		});
		navigate(q(parent));
	}

	return (
		<ShellContext value={shell}>
			<Sidebar>
				<SidebarHeader>
					<div className="flex h-12 items-center gap-2 p-2 text-sm [&_svg]:size-4">
						<ShipIcon />
						<span className="font-semibold">File Captain</span>
					</div>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Folders</SidebarGroupLabel>
						<SidebarGroupContent>{folders}</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<div className="flex h-8 items-center justify-between gap-2 px-2">
						{account}
						<SignOutButton />
					</div>
				</SidebarFooter>
			</Sidebar>

			<SidebarInset>{children}</SidebarInset>

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

			<ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />

			{/* Lives in the shell so uploads continue across folders. */}
			<Uploader
				dir={upload.dir}
				dropDir={dropDir}
				onBusyChange={setUploading}
				onOpenChange={(open) => setUpload((u) => ({ ...u, open }))}
				// Not `refresh`: that dims the folder, which would flicker every
				// few seconds during a long batch.
				onUploaded={() => router.refresh()}
				open={upload.open}
			/>
			<IndexingToast />
		</ShellContext>
	);
}

/** A Link whose navigation shows as pending (see `navigate`). */
function FolderLink(props: React.ComponentProps<typeof Link>) {
	const { navigate } = useShell();
	return (
		<Link
			{...props}
			onNavigate={(e) => {
				e.preventDefault();
				navigate(props.href.toString());
			}}
		/>
	);
}

/** The sidebar's folder list, with a usage bar under each limited folder. */
export function FolderLinks({ folders }: { folders: Entry[] }) {
	const path = useSearchParams().get("path") || "/";
	// "/" shows the first folder (see the page).
	const active = path === "/" ? folders[0]?.name : path.split("/")[1];
	return (
		<SidebarMenu className="gap-1">
			{folders.map((folder) => (
				<SidebarMenuItem key={folder.name}>
					<SidebarMenuButton
						className="data-active:bg-blue-200 data-active:hover:bg-blue-200 dark:data-active:bg-blue-900 dark:data-active:hover:bg-blue-900"
						isActive={folder.name === active}
						render={<FolderLink href={q(`/${folder.name}`)} />}
						title={
							folder.limit === undefined
								? undefined
								: `${formatSize(folder.size)} of ${formatSize(folder.limit)} used${folder.disk ? " on disk" : ""}`
						}
					>
						<FolderIcon />
						<span className="flex-1 truncate">{folder.name}</span>
						{folder.limit !== undefined && (
							<FolderUsage limit={folder.limit} used={folder.size} />
						)}
					</SidebarMenuButton>
				</SidebarMenuItem>
			))}
		</SidebarMenu>
	);
}

export function FolderLinksSkeleton() {
	return (
		<SidebarMenu className="gap-1">
			{["60%", "80%", "50%"].map((width) => (
				<SidebarMenuItem key={width}>
					<SidebarMenuSkeleton showIcon width={width} />
				</SidebarMenuItem>
			))}
		</SidebarMenu>
	);
}

/** The bar above a folder view. The same in the skeleton, so nothing shifts. */
function FolderHeader({
	breadcrumbs,
	busy,
	writable,
	onNewFolder,
	onUpload,
}: {
	breadcrumbs?: React.ReactNode;
	busy: boolean;
	writable: boolean;
	onNewFolder?: () => void;
	onUpload?: () => void;
}) {
	const { openSearch, openShortcuts, uploading } = useShell();
	return (
		<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
			<SidebarTrigger className="-ml-1" />
			<div className="min-w-0 flex-1">{breadcrumbs}</div>
			<Loader2Icon
				aria-hidden={!busy}
				aria-label="Loading"
				className={cn(
					"size-4 shrink-0 animate-spin text-muted-foreground",
					!busy && "invisible",
				)}
			/>
			<div className="flex gap-2">
				<Button
					onClick={openSearch}
					size="icon"
					title="Search (⌘F / Ctrl+F)"
					variant="ghost"
				>
					<SearchIcon />
					<span className="sr-only">Search</span>
				</Button>
				<Button
					aria-keyshortcuts="Shift+?"
					onClick={openShortcuts}
					size="icon"
					title="Keyboard shortcuts (?)"
					variant="ghost"
				>
					<KeyboardIcon />
					<span className="sr-only">Keyboard shortcuts</span>
				</Button>
				<Button disabled={!writable} onClick={onNewFolder} variant="outline">
					<FolderPlusIcon />
					New folder
				</Button>
				<Button
					disabled={!writable}
					onClick={onUpload}
					title={uploading ? "Uploading…" : undefined}
				>
					{uploading ? (
						<Loader2Icon className="animate-spin" />
					) : (
						<UploadIcon />
					)}
					Upload
				</Button>
			</div>
		</header>
	);
}

/** Shown while the folder view streams in. Matches its layout. */
export function FolderViewSkeleton() {
	const { pending } = useShell();
	return (
		<>
			<FolderHeader
				breadcrumbs={<Skeleton className="h-4 w-40" />}
				busy={pending}
				writable={false}
			/>
			<div className="flex flex-1 flex-col gap-4 p-4">
				<Table className="table-fixed">
					<FileTableHeader />
					<TableBody>
						{["40%", "65%", "30%", "55%", "45%", "70%", "35%", "50%"].map(
							(width) => (
								<TableRow className="hover:bg-transparent" key={width}>
									<TableCell>
										<div className="flex items-center gap-3">
											<Skeleton className="size-8 shrink-0" />
											<Skeleton className="h-4" style={{ width }} />
										</div>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<Skeleton className="ml-auto h-4 w-12" />
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<Skeleton className="h-4 w-32" />
									</TableCell>
								</TableRow>
							),
						)}
					</TableBody>
				</Table>
			</div>
		</>
	);
}

/** Shown instead of the folder view when the folder can't be opened. */
export function FolderViewError({ message }: { message: string }) {
	const { pending } = useShell();
	return (
		<>
			<FolderHeader busy={pending} writable={false} />
			<div className="flex flex-1 flex-col gap-4 p-4">
				<Alert variant="destructive">
					<CircleAlertIcon />
					<AlertTitle>Could not open folder</AlertTitle>
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			</div>
		</>
	);
}

/** One folder: breadcrumbs, the listing, its context menu and action dialogs. */
export function FolderView({
	path,
	listing,
	readOnly,
}: {
	/** The folder shown, e.g. /shared/photos. */
	path: string;
	listing: Listing;
	/** The user can't write anywhere, so copying is pointless too. */
	readOnly: boolean;
}) {
	const shell = useShell();
	const { selected, setSelected, clip, setClip, navigate, refresh } = shell;
	const segments = path.split("/").filter(Boolean);
	const writable = listing.writable;
	const select = (name: string | null) =>
		setSelected(
			name === null ? null : { path, names: [name], anchor: name, lead: name },
		);
	const rows = useMemo(() => sortEntries(listing.entries), [listing.entries]);

	// Files dropped anywhere on the page upload into this folder.
	const { setDropDir } = shell;
	useEffect(() => {
		if (!writable || path === "/") return;
		setDropDir(path);
		return () => setDropDir(null);
	}, [path, writable, setDropDir]);

	// The open action dialog, and its input/submitting state.
	const [dialog, setDialog] = useState<{
		action: Action;
		/** The entry renamed, or the entries deleted. */
		entries: Entry[];
	} | null>(null);
	const [value, setValue] = useState("");
	const [submitting, setSubmitting] = useState(false);
	// A paste or delete is running (see forEachName).
	const [working, setWorking] = useState(false);
	// The file shown in the full-screen preview.
	const [preview, setPreview] = useState<Entry | null>(null);
	const files = useMemo(() => rows.filter((e) => e.type === "file"), [rows]);

	function open(action: Action, entries: Entry[] = []) {
		setDialog({ action, entries });
		setValue(action === "rename" ? (entries[0]?.name ?? "") : "");
		setSubmitting(false);
	}

	const trimmed = value.trim();
	const targets = dialog?.entries ?? [];
	const name = targets[0]?.name ?? "";
	const kind = targets[0]?.type === "dir" ? "folder" : "file";
	const dialogs: Record<
		Action,
		{
			title: string;
			description: string;
			confirm: string;
			input: boolean;
			/** The toast title when `run` fails. */
			failure: string;
			run: () => Promise<unknown>;
		}
	> = {
		mkdir: {
			title: "New folder",
			description: `Create a folder in ${path}.`,
			confirm: "Create",
			input: true,
			failure: "Couldn't create the folder",
			run: () => api("/api/files/mkdir", { path: join(path, trimmed) }),
		},
		rename: {
			title: `Rename ${kind}`,
			description: `Enter a new name for "${name}".`,
			confirm: "Rename",
			input: true,
			failure: `Couldn't rename "${name}"`,
			run: () =>
				api("/api/files/rename", {
					path: join(path, name),
					newName: trimmed,
				}),
		},
		delete: {
			title:
				targets.length > 1
					? `Delete ${targets.length} items?`
					: `Delete ${kind}?`,
			description:
				targets.length > 1
					? targets.some((e) => e.type === "dir")
						? `These ${targets.length} items, including everything in the folders among them, will be permanently deleted.`
						: `These ${targets.length} items will be permanently deleted.`
					: kind === "folder"
						? `"${name}" and everything in it will be permanently deleted.`
						: `"${name}" will be permanently deleted.`,
			confirm: "Delete",
			input: false,
			failure: "Couldn't delete",
			run: () => removeEntries(targets.map((e) => e.name)),
		},
	};
	const current = dialog ? dialogs[dialog.action] : null;

	// Names compare case-insensitively: "Photo.jpg" and "photo.jpg" can't
	// both exist (file-service enforces this too). The entry being renamed
	// doesn't count, so only its capitalization can change.
	const lower = trimmed.toLowerCase();
	const taken = current?.input
		? listing.entries.find(
				(entry) =>
					entry.name.toLowerCase() === lower &&
					!(dialog?.action === "rename" && entry.name === name),
			)
		: undefined;
	// Nothing to do: no name, or a rename to exactly the same name.
	const nameBlocked =
		!!current?.input &&
		(!trimmed || (dialog?.action === "rename" && trimmed === name));

	async function confirm(e: React.FormEvent) {
		e.preventDefault();
		if (!current || nameBlocked) return;
		if (!current.input) {
			// Deleting shows its own progress, so the dialog needn't wait.
			setDialog(null);
			await current.run();
			return;
		}
		// Checked here rather than by disabling the button, so the user is
		// told why. The server checks again (it may have changed meanwhile).
		if (taken) {
			toast.error("Name already taken", {
				description: `"${taken.name}" already exists in ${path}.${
					taken.name === trimmed
						? ""
						: " Names that differ only in capitalization aren't allowed."
				}`,
			});
			return;
		}
		setSubmitting(true);
		try {
			await current.run();
			select(trimmed);
			setDialog(null);
			refresh();
		} catch (err) {
			// Keep the dialog open so the user can fix the name and retry.
			const conflict = err instanceof ApiError && err.code === "CONFLICT";
			toast.error(conflict ? "Name already taken" : current.failure, {
				description: (err as Error).message,
			});
		}
		setSubmitting(false);
	}

	const selectedNames = selected?.path === path ? selected.names : [];
	const selectedEntries = listing.entries.filter((entry) =>
		selectedNames.includes(entry.name),
	);
	// Nothing can be pasted into the virtual root.
	const canPaste = clip !== null && writable && path !== "/" && !working;

	/** Downloads entries of this folder as one zip. A form POST, so the browser streams it to disk. */
	function downloadZip(entries: Entry[]) {
		startDownload("POST", "/api/files/zip", [
			["dir", path],
			...entries.map((entry): [string, string] => ["name", entry.name]),
		]);
	}

	/** Opens a folder, or shows a file full-screen. */
	function openEntry(entry: Entry) {
		if (entry.type === "dir") navigate(q(join(path, entry.name)));
		else setPreview(entry);
	}

	/** Shows `entry` in the open preview, and selects it so closing returns to it. */
	function showPreview(entry: Entry) {
		setPreview(entry);
		select(entry.name);
	}

	function download(entry: Entry) {
		startDownload("GET", "/api/files/download", [
			["path", join(path, entry.name)],
		]);
	}

	/**
	 * Runs `op` on each name in turn, then refreshes the folder. Several
	 * names get a progress toast; the outcome is always reported in one.
	 * Returns the names that succeeded.
	 */
	async function forEachName(
		names: string[],
		messages: {
			/** e.g. "Deleting", shown as "Deleting 3 of 10…". */
			progress: string;
			/** e.g. "Couldn't delete", followed by the failed names. */
			failure: string;
			success: (done: string[]) => string;
		},
		op: (name: string) => Promise<unknown>,
	) {
		setWorking(true);
		const total = names.length;
		const id =
			total > 1
				? toast.loading(`${messages.progress} 1 of ${total}…`)
				: undefined;
		const done: string[] = [];
		const failed: string[] = [];
		let firstError = "";
		for (const [i, name] of names.entries()) {
			if (id !== undefined && i > 0) {
				toast.loading(`${messages.progress} ${i + 1} of ${total}…`, { id });
			}
			try {
				await op(name);
				done.push(name);
			} catch (err) {
				failed.push(name);
				firstError ||= (err as Error).message;
			}
		}
		if (failed.length > 0) {
			toast.error(`${messages.failure} ${describe(failed)}`, {
				id,
				description:
					done.length > 0
						? `${done.length} of ${total} succeeded. ${firstError}`
						: firstError,
			});
		} else {
			toast.success(messages.success(done), { id });
		}
		setWorking(false);
		// Also after a failure: a copy may have stopped partway.
		refresh();
		return done;
	}

	/** Marks entries of this folder for pasting elsewhere. */
	function clipEntries(mode: Clip["mode"], entries: Entry[]) {
		const names = entries.map((e) => e.name);
		setClip({ mode, dir: path, names });
		toast(`${mode === "cut" ? "Cut" : "Copied"} ${describe(names)}`, {
			description:
				"Open a folder and paste with ⌘V / Ctrl+V, or right-click and choose Paste.",
		});
	}

	async function paste() {
		if (!clip || working) return;
		const { mode, dir, names } = clip;
		// Cutting and pasting into the same folder changes nothing.
		if (mode === "cut" && dir === path) return setClip(null);
		const taken = listing.entries.map((e) => e.name);
		const pasted: string[] = [];
		const done = await forEachName(
			names,
			mode === "cut"
				? {
						progress: "Moving",
						failure: "Couldn't move",
						success: (done) => `Moved ${describe(done)} to ${path}`,
					}
				: {
						progress: "Copying",
						failure: "Couldn't copy",
						success: (done) => `Copied ${describe(done)} to ${path}`,
					},
			async (name) => {
				// A copy into its own folder gets a new name: "a copy.txt".
				const dst = dir === path ? copyName(name, taken) : name;
				taken.push(dst);
				await api(mode === "cut" ? "/api/files/move" : "/api/files/copy", {
					src: join(dir, name),
					dst: join(path, dst),
				});
				pasted.push(dst);
			},
		);
		// What failed to move stays on the clipboard to try again.
		if (mode === "cut") {
			const left = names.filter((n) => !done.includes(n));
			setClip(left.length > 0 ? { ...clip, names: left } : null);
		}
		const [first] = pasted;
		const last = pasted[pasted.length - 1];
		if (first && last) {
			setSelected({ path, names: pasted, anchor: first, lead: last });
		}
	}

	async function removeEntries(names: string[]) {
		const done = await forEachName(
			names,
			{
				progress: "Deleting",
				failure: "Couldn't delete",
				success: (done) => `Deleted ${describe(done)}`,
			},
			(name) => api("/api/files/delete", { path: join(path, name) }),
		);
		if (done.length > 0) setSelected(null);
	}

	function actionsFor(entries: Entry[]): EntryAction[] {
		const [entry] = entries;
		if (!entry) return [];
		const actions: EntryAction[] = [];
		if (entries.length > 1) {
			// Top-level folders (at "/") can't be zipped together.
			if (path !== "/") {
				actions.push({
					label: "Download (.zip)",
					icon: DownloadIcon,
					run: () => downloadZip(entries),
				});
			}
		} else if (entry.type === "dir") {
			actions.push({
				label: "Open",
				icon: FolderOpenIcon,
				run: () => openEntry(entry),
			});
			// Top-level folders (at "/") can't be zipped.
			if (path !== "/") {
				actions.push({
					label: "Download (.zip)",
					icon: DownloadIcon,
					run: () => downloadZip([entry]),
				});
			}
		} else {
			actions.push(
				{ label: "Open", icon: EyeIcon, run: () => openEntry(entry) },
				{
					label: "Download",
					icon: DownloadIcon,
					run: () => download(entry),
				},
			);
		}
		if (path === "/") return actions;
		if (!readOnly) {
			actions.push({
				label: "Copy",
				icon: CopyIcon,
				run: () => clipEntries("copy", entries),
			});
		}
		if (writable) {
			actions.push({
				label: "Cut",
				icon: ScissorsIcon,
				run: () => clipEntries("cut", entries),
			});
			if (entries.length === 1) {
				actions.push({
					label: "Rename",
					icon: PencilIcon,
					run: () => open("rename", entries),
				});
			}
			actions.push({
				label: "Delete",
				icon: Trash2Icon,
				run: () => open("delete", entries),
				destructive: true,
			});
		}
		return actions;
	}

	const busy = shell.pending || working;

	/** Runs the selection's context-menu action with this label, if it has one. */
	function runAction(label: string) {
		actionsFor(selectedEntries)
			.find((action) => action.label === label)
			?.run();
	}

	/** Selects the row at `index`, or extends the selection to it from the anchor. */
	function moveTo(index: number, extend: boolean) {
		const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
		if (!target) return;
		const anchor = selected?.path === path ? selected.anchor : null;
		if (extend && anchor !== null && rows.some((r) => r.name === anchor)) {
			setSelected({
				path,
				names: rangeOf(rows, anchor, target.name),
				anchor,
				lead: target.name,
			});
		} else {
			select(target.name);
		}
	}

	/** Opens a subfolder from the keyboard with its first entry selected. */
	function goInto(entry: Entry) {
		const child = join(path, entry.name);
		setSelected({ path: child, names: [], anchor: "", lead: "" });
		navigate(q(child));
	}

	// An empty selection for this folder (set by goInto before it loaded)
	// becomes its first entry.
	useEffect(() => {
		if (selected?.path !== path || selected.names.length > 0) return;
		const [first] = rows;
		setSelected(
			first
				? { path, names: [first.name], anchor: first.name, lead: first.name }
				: null,
		);
	}, [selected, path, rows, setSelected]);

	/** Opens the parent folder with the current one selected. */
	function goUp() {
		const name = segments[segments.length - 1];
		// The virtual root isn't browsable (the page shows the first folder).
		if (segments.length < 2 || !name) return;
		const parent = `/${segments.slice(0, -1).join("/")}`;
		setSelected({ path: parent, names: [name], anchor: name, lead: name });
		navigate(q(parent));
	}

	// The context menu normally needs a right-click; open it with the
	// keyboard by sending one to the selected row (or the empty listing).
	const triggerRef = useRef<HTMLDivElement>(null);
	function openMenu() {
		const target =
			selectedNames.length > 0
				? document.querySelector("tr[data-name][data-state=selected]")
				: triggerRef.current;
		if (!target) return;
		const rect = target.getBoundingClientRect();
		target.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: rect.left + Math.min(rect.width / 2, 48),
				clientY: rect.top + Math.min(rect.height / 2, 24),
			}),
		);
	}

	const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
		if (e.defaultPrevented || e.altKey || isForFocused(e)) return;
		const mod = e.metaKey || e.ctrlKey;
		const key = mod ? `Mod+${e.key.toLowerCase()}` : e.key;
		const lead = selected?.path === path ? selected.lead : null;
		const leadIndex = rows.findIndex((r) => r.name === lead);
		const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
		const handlers: Record<string, () => void> = {
			ArrowDown: () => moveTo(leadIndex < 0 ? 0 : leadIndex + 1, e.shiftKey),
			ArrowUp: () =>
				moveTo(leadIndex < 0 ? rows.length - 1 : leadIndex - 1, e.shiftKey),
			Home: () => moveTo(0, e.shiftKey),
			End: () => moveTo(rows.length - 1, e.shiftKey),
			"Mod+a": () => {
				const [first] = rows;
				const last = rows[rows.length - 1];
				if (first && last) {
					setSelected({
						path,
						names: rows.map((r) => r.name),
						anchor: first.name,
						lead: last.name,
					});
				}
			},
			ArrowRight: () => {
				if (single?.type === "dir") goInto(single);
			},
			"Mod+arrowdown": () => {
				if (single?.type === "dir") goInto(single);
			},
			Enter: () => {
				if (single?.type === "dir") goInto(single);
				else if (single) openEntry(single);
			},
			ArrowLeft: goUp,
			"Mod+arrowup": goUp,
			F2: () => runAction("Rename"),
			Delete: () => runAction("Delete"),
			"Mod+backspace": () => runAction("Delete"),
			"Mod+c": () => runAction("Copy"),
			"Mod+x": () => runAction("Cut"),
			"Mod+v": () => {
				if (canPaste) paste();
			},
			ContextMenu: openMenu,
		};
		if (key === "F10" && e.shiftKey) handlers.F10 = openMenu;
		// Without a selection, copy and cut stay the browser's.
		if ((key === "Mod+c" || key === "Mod+x") && selectedEntries.length === 0)
			return;
		const handler = handlers[key];
		if (!handler) return;
		e.preventDefault();
		handler();
	});
	useEffect(() => {
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<>
			<FolderHeader
				breadcrumbs={
					<Breadcrumb>
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
												<BreadcrumbLink render={<FolderLink href={q(href)} />}>
													{segment}
												</BreadcrumbLink>
											)}
										</BreadcrumbItem>
									</Fragment>
								);
							})}
						</BreadcrumbList>
					</Breadcrumb>
				}
				busy={busy}
				onNewFolder={() => open("mkdir")}
				onUpload={() => shell.openUpload(path)}
				writable={writable}
			/>

			<ContextMenu>
				<ContextMenuTrigger
					aria-busy={busy}
					className={cn(
						"flex flex-1 select-auto flex-col gap-4 p-4 transition-opacity",
						busy && "opacity-60",
					)}
					onContextMenu={(e) => {
						// Right-click on a selected row keeps the selection; on another
						// row it selects just that one; on empty space it clears the
						// selection so the menu offers folder actions.
						const row = (e.target as Element).closest("tr[data-name]");
						const name = row?.getAttribute("data-name") ?? null;
						if (name === null || !selectedNames.includes(name)) select(name);
					}}
					ref={triggerRef}
				>
					<FileTable
						anchor={selected?.path === path ? selected.anchor : null}
						entries={rows}
						lead={selected?.path === path ? selected.lead : null}
						onOpen={openEntry}
						onSelect={(names, anchor, lead) =>
							setSelected({ path, names, anchor, lead })
						}
						path={path}
						selected={selectedNames}
					/>
				</ContextMenuTrigger>
				<ContextMenuContent data-keep-selection>
					{selectedEntries.length > 0 ? (
						actionsFor(selectedEntries).map((action) => (
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
								{clip ? `Paste ${describe(clip.names)}` : "Paste"}
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
								onClick={() => shell.openUpload(path)}
							>
								<UploadIcon />
								Upload
							</ContextMenuItem>
						</>
					)}
				</ContextMenuContent>
			</ContextMenu>
			<FilePreview
				dir={path}
				entries={files}
				entry={preview}
				onClose={() => setPreview(null)}
				onDownload={download}
				onShow={showPreview}
			/>

			<AlertDialog
				onOpenChange={(isOpen) => {
					if (!isOpen && !submitting) setDialog(null);
				}}
				open={dialog !== null}
			>
				<AlertDialogContent data-keep-selection>
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
									disabled={submitting}
									onChange={(e) => setValue(e.target.value)}
									value={value}
								/>
							)}
							<AlertDialogFooter>
								<AlertDialogCancel disabled={submitting} type="button">
									Cancel
								</AlertDialogCancel>
								<AlertDialogAction
									disabled={submitting || nameBlocked}
									type="submit"
									variant={
										dialog?.action === "delete" ? "destructive" : "default"
									}
								>
									{submitting ? "Working…" : current.confirm}
								</AlertDialogAction>
							</AlertDialogFooter>
						</form>
					)}
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function FileTableHeader() {
	return (
		<TableHeader>
			<TableRow>
				<TableHead>Name</TableHead>
				<TableHead className="hidden w-24 text-right sm:table-cell">
					Size
				</TableHead>
				<TableHead className="hidden w-48 md:table-cell">Modified</TableHead>
			</TableRow>
		</TableHeader>
	);
}

/**
 * The folder listing, already sorted. Only the rows in view are rendered, with spacer rows
 * standing in for the rest, so folders with thousands of entries stay fast.
 * Click selects a row, Shift-click a range from the anchor, and Cmd/Ctrl-click
 * adds or removes one.
 */
function FileTable({
	path,
	entries,
	selected,
	anchor,
	lead,
	onSelect,
	onOpen,
}: {
	path: string;
	entries: Entry[];
	selected: string[];
	anchor: string | null;
	lead: string | null;
	onSelect: (names: string[], anchor: string, lead: string) => void;
	onOpen: (entry: Entry) => void;
}) {
	const rows = entries;
	const selectedSet = useMemo(() => new Set(selected), [selected]);

	function click(e: React.MouseEvent, name: string) {
		if (e.shiftKey && anchor !== null && rows.some((r) => r.name === anchor)) {
			onSelect(rangeOf(rows, anchor, name), anchor, name);
		} else if (e.metaKey || e.ctrlKey) {
			onSelect(
				selectedSet.has(name)
					? selected.filter((n) => n !== name)
					: [...selected, name],
				name,
				name,
			);
		} else {
			onSelect([name], name, name);
		}
	}
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
		// Keeps rows reached with the arrow keys clear of the sticky header.
		scrollPaddingStart: 56,
	});

	// Brings the selected entry into view when a folder opens with one
	// already selected, e.g. after opening a search result. Only when the
	// folder changes: a refresh (e.g. as uploads finish) mustn't scroll the
	// list away from where the user is.
	const scrollToSelected = useEffectEvent(() => {
		const index = rows.findIndex((e) => e.name === selected[0]);
		if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per folder, see above
	useEffect(() => scrollToSelected(), [path]);

	// Keeps the row moved to with the arrow keys in view.
	const scrollToLead = useEffectEvent(() => {
		const index = rows.findIndex((e) => e.name === lead);
		if (index >= 0) virtualizer.scrollToIndex(index);
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the lead moves, see above
	useEffect(() => scrollToLead(), [lead]);

	const items = virtualizer.getVirtualItems();
	const first = items[0];
	const last = items[items.length - 1];
	const padTop = first ? first.start - scrollMargin : 0;
	const padBottom = last ? virtualizer.getTotalSize() - last.end : 0;

	return (
		<Table
			aria-label="Files"
			aria-multiselectable
			className="table-fixed"
			ref={tableRef}
			role="grid"
		>
			<FileTableHeader />
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
							aria-selected={selectedSet.has(entry.name)}
							className="cursor-pointer select-none data-[state=selected]:bg-blue-200 data-[state=selected]:hover:bg-blue-200 dark:data-[state=selected]:bg-blue-900 dark:data-[state=selected]:hover:bg-blue-900"
							data-index={item.index}
							data-name={entry.name}
							data-state={selectedSet.has(entry.name) ? "selected" : undefined}
							key={entry.name}
							onClick={(e) => click(e, entry.name)}
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
								{formatShortDate(entry.mtime)}
							</TableCell>
						</TableRow>
					);
				})}
				{padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
			</TableBody>
		</Table>
	);
}

/**
 * A short bar at the end of a folder's sidebar row: how much of its
 * storageLimit (or its disk, without one) is used. Yellow above 75%, red
 * above 90%. The row's tooltip gives the numbers.
 */
function FolderUsage({ used, limit }: { used: number; limit: number }) {
	const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
	return (
		<div className="w-12 shrink-0">
			<div className="h-1 overflow-hidden rounded-full bg-sidebar-border">
				<div
					className={cn(
						"h-full rounded-full",
						percent > 90
							? "bg-destructive"
							: percent > 75
								? "bg-yellow-500"
								: "bg-primary",
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
	// The latest answer, and the term it answers.
	const [found, setFound] = useState<{
		term: string;
		results: SearchResult[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The result picked with the arrow keys.
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const term = query.trim();
	// Results for an older term stay visible, dimmed, until the new ones arrive.
	const stale = found !== null && found.term !== term;
	const searching = !!term && !error && (found === null || stale);
	const results = found?.results ?? null;

	// Waits for a pause in typing, and ignores answers to older queries.
	useEffect(() => {
		if (!term) {
			setFound(null);
			setError(null);
			return;
		}
		let ignore = false;
		const timer = setTimeout(() => {
			api<{ results: SearchResult[] }>(
				`/api/files/search?q=${encodeURIComponent(term)}`,
			)
				.then((data) => {
					if (ignore) return;
					setFound({ term, results: data.results });
					setError(null);
					setActive(0);
				})
				.catch((err: Error) => {
					if (!ignore) setError(err.message);
				});
		}, 200);
		return () => {
			ignore = true;
			clearTimeout(timer);
		};
	}, [term]);

	// Moves the selection with the arrow keys and keeps it in view. Hovering
	// also sets it, but shouldn't scroll, so this isn't an effect.
	function moveTo(index: number) {
		setActive(index);
		listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
	}

	function onKeyDown(e: React.KeyboardEvent) {
		const count = results?.length ?? 0;
		if (e.key === "ArrowDown" && count) {
			e.preventDefault();
			moveTo((active + 1) % count);
		} else if (e.key === "ArrowUp" && count) {
			e.preventDefault();
			moveTo((active - 1 + count) % count);
		} else if (e.key === "Enter") {
			const result = results?.[active];
			if (term && !stale && result) onOpen(result);
		}
	}

	return (
		<>
			<div className="relative border-b">
				<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					aria-label="Search files"
					autoFocus
					className="h-11 rounded-none border-0 bg-transparent pr-9 pl-9 shadow-none focus-visible:ring-0"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search files and folders"
					type="search"
					value={query}
				/>
				<Loader2Icon
					aria-hidden={!searching}
					aria-label="Searching"
					className={cn(
						"pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground",
						!searching && "invisible",
					)}
				/>
			</div>
			{term && (
				<div
					aria-busy={searching}
					className={cn(
						"max-h-[60vh] overflow-y-auto p-1 transition-opacity",
						stale && "opacity-60",
					)}
					ref={listRef}
				>
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

const SHORTCUTS: [keys: string, action: string][] = [
	["↑ / ↓", "Move the selection"],
	["Shift + ↑ / ↓", "Extend the selection"],
	["Home / End", "Select the first / last item"],
	["⌘/Ctrl + A", "Select all"],
	["Esc", "Clear the selection"],
	["→ or Enter", "Open the folder (Enter on a file: preview it)"],
	["← / → in a preview", "Previous / next file"],
	["←", "Go to the parent folder"],
	[
		"Shift + F10 or Menu key",
		"Actions for the selection, e.g. Download (.zip)",
	],
	["F2", "Rename"],
	["Delete or ⌘ + Backspace", "Delete"],
	["⌘/Ctrl + C / X / V", "Copy / cut / paste"],
	["⌘/Ctrl + F", "Search"],
	["?", "Show these shortcuts"],
];

/** Lists the keyboard shortcuts. */
function ShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md" data-keep-selection>
				<DialogTitle>Keyboard shortcuts</DialogTitle>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					{SHORTCUTS.map(([keys, action]) => (
						<Fragment key={keys}>
							<dt>
								<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
									{keys}
								</kbd>
							</dt>
							<dd className="text-muted-foreground">{action}</dd>
						</Fragment>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}

function EntryIcon({ entry, path }: { entry: Entry; path: string }) {
	const [failed, setFailed] = useState(false);
	if (entry.type === "dir") {
		return <FolderIcon className="size-8 shrink-0 p-1 text-muted-foreground" />;
	}
	if (!entry.thumbnail || failed) {
		return <TypeIcon className="size-8 shrink-0 p-1" name={entry.name} />;
	}
	return (
		// biome-ignore lint/performance/noImgElement: thumbnails are already sized webp from our API
		<img
			alt=""
			className="size-8 shrink-0 rounded-sm object-cover"
			loading="lazy"
			onError={() => setFailed(true)}
			src={thumbnailUrl(path, entry)}
		/>
	);
}
