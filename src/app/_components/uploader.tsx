"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import Uppy, { type UppyFile } from "@uppy/core";
import DropTarget from "@uppy/drop-target";
import Tus from "@uppy/tus";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	CircleAlertIcon,
	CircleCheckIcon,
	FileIcon,
	Loader2Icon,
	RotateCwIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Progress } from "~/components/ui/progress";
import { formatSize } from "~/lib/format";
import { cn } from "~/lib/utils";

type Meta = {
	dir?: string;
	name: string;
	type?: string;
	/** Set by DropTarget for files inside a dropped folder, e.g. docs/a.pdf. */
	relativePath?: string | null;
};
type File = UppyFile<Meta, Record<string, never>>;

/** How often the panel re-reads Uppy's state. Progress events come far faster. */
const RENDER_MS = 250;
/** How often the folder view refreshes while uploads keep finishing. */
const REFRESH_MS = 5000;
/** Height of one file in the panel's list; fixed, so the list can virtualize. */
const ROW_HEIGHT = 52;

/** Pulls the `{ error: { message } }` body our tus hooks send back. */
function errorMessage(response: unknown, fallback: string) {
	const text = (response as { body?: { xhr?: XMLHttpRequest } } | undefined)
		?.body?.xhr?.responseText;
	try {
		return JSON.parse(text ?? "").error.message as string;
	} catch {
		return fallback;
	}
}

const plural = (n: number, noun: string) =>
	`${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Uploads into `dir` (a virtual path like /shared/photos) over tus. Stays
 * mounted so uploads keep going while the folder changes. The dialog only
 * picks files; progress shows in a small panel in the corner, built to stay
 * fast with thousands of files: it lists only the files being sent right now
 * and the failures, and counts the rest. While `dropDir` is set, files
 * dropped anywhere on the page upload there.
 */
export function Uploader({
	dir,
	dropDir,
	open,
	onOpenChange,
	onUploaded,
	onBusyChange,
}: {
	dir: string;
	/** The writable folder on screen, or null when dropping isn't allowed. */
	dropDir: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called as files finish (at most every REFRESH_MS) and when all are done. */
	onUploaded: () => void;
	/** Called with true while any upload is in progress. */
	onBusyChange: (busy: boolean) => void;
}) {
	const [uppy, setUppy] = useState<Uppy<Meta, Record<string, never>> | null>(
		null,
	);
	const [files, setFiles] = useState<File[]>([]);
	const [dragging, setDragging] = useState(false);
	// Read when a file is added, so files keep the folder they were added in.
	const dirRef = useRef(dir);
	dirRef.current = dir;
	const dropDirRef = useRef(dropDir);
	dropDirRef.current = dropDir;
	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	// Set when a dropped folder's contents were skipped, reported on drop.
	const skippedFolder = useRef(false);
	const onUploadedRef = useRef(onUploaded);
	onUploadedRef.current = onUploaded;
	// The HTTP status of each failed upload; 4xx failures won't succeed on retry.
	const failedStatus = useRef(new Map<string, number>());

	useEffect(() => {
		const instance = new Uppy<Meta, Record<string, never>>({
			autoProceed: true,
			onBeforeFileAdded: (file, files) => {
				// Uploads go into one folder; recreating dropped trees is unsupported.
				if (file.meta.relativePath?.includes("/")) {
					skippedFolder.current = true;
					return false;
				}
				// Files re-added for a retry keep their original folder.
				const target =
					file.meta.dir ??
					(file.source === "DropTarget"
						? (dropDirRef.current ?? dirRef.current)
						: dirRef.current);
				const folder = target.split("/")[1] ?? "";
				// Uppy identifies a file by its name, type, size and date only.
				// The same file sent to two folders is two uploads: two rows in
				// the panel, and two resumable tus uploads (tus keys on the id).
				const id = `${file.id}-${target}`;
				// Already listed for this folder: its row shows how it went.
				if (Object.hasOwn(files, id)) return false;
				return {
					...file,
					id,
					meta: { ...file.meta, dir: target },
					tus: { endpoint: `/api/upload/${encodeURIComponent(folder)}` },
				};
			},
		}).use(Tus, {
			endpoint: "/api/upload",
			chunkSize: 50 * 1024 * 1024,
			// Browsers allow 6 connections per host; keep one for browsing.
			limit: 5,
			retryDelays: [0, 1000, 3000, 5000],
			// Conflicts and permission errors won't fix themselves.
			onShouldRetry: (err, _attempt, _options, next) => {
				const status = err.originalResponse?.getStatus() ?? 0;
				return status >= 400 && status < 500 ? false : next(err);
			},
			removeFingerprintOnSuccess: true,
		});

		// Progress events arrive many times a second per file; re-rendering a
		// list of thousands on each would freeze the page.
		let renderTimer: ReturnType<typeof setTimeout> | undefined;
		instance.on("state-update", () => {
			renderTimer ??= setTimeout(() => {
				renderTimer = undefined;
				setFiles(instance.getFiles());
			}, RENDER_MS);
		});

		// Replace tus' long technical message with the server's own.
		instance.on("upload-error", (file, err, response) => {
			if (!file) return;
			failedStatus.current.set(
				file.id,
				(
					err as { originalResponse?: { getStatus(): number } | null }
				).originalResponse?.getStatus() ?? 0,
			);
			instance.setFileState(file.id, {
				error: errorMessage(response, err.message),
			});
		});
		instance.on("file-removed", (file) => failedStatus.current.delete(file.id));

		// New files show up in the folder while a long batch is still running.
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		instance.on("upload-success", () => {
			refreshTimer ??= setTimeout(() => {
				refreshTimer = undefined;
				onUploadedRef.current();
			}, REFRESH_MS);
		});
		instance.on("complete", () => {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
			onUploadedRef.current();
		});

		setUppy(instance);
		return () => {
			clearTimeout(renderTimer);
			clearTimeout(refreshTimer);
			instance.destroy();
		};
	}, []);

	// Page-wide drop target, only while a writable folder is on screen.
	const droppable = dropDir !== null;
	const overlayRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!uppy || !droppable) return;
		uppy.use(DropTarget, {
			target: document.body,
			onDragOver: () => setDragging(true),
			// The overlay covers the page once shown, so leaving it means the
			// drag left the window or was cancelled.
			onDragLeave: (e) => {
				if (e.target === overlayRef.current) setDragging(false);
			},
			onDrop: () => {
				setDragging(false);
				if (skippedFolder.current) {
					skippedFolder.current = false;
					toast.error("Folders can't be uploaded, only files.");
				}
				// Progress shows in the panel; the dialog (if open) would hide it.
				onOpenChangeRef.current(false);
			},
		});
		return () => {
			const plugin = uppy.getPlugin("DropTarget");
			if (plugin) uppy.removePlugin(plugin);
			setDragging(false);
		};
	}, [uppy, droppable]);

	function add(list: FileList | null) {
		if (!uppy || !list?.length) return;
		try {
			// One call for the whole selection: adding files one by one
			// re-renders Uppy's state for each.
			uppy.addFiles(
				Array.from(list, (data) => ({
					name: data.name,
					type: data.type,
					data,
				})),
			);
		} catch {
			// Uppy rejects files already in the list; nothing to do.
		}
		onOpenChange(false);
	}

	const busy = files.some(
		(f) => f.progress.uploadStarted && !f.progress.uploadComplete && !f.error,
	);
	const onBusyChangeRef = useRef(onBusyChange);
	onBusyChangeRef.current = onBusyChange;
	useEffect(() => {
		onBusyChangeRef.current(busy);
	}, [busy]);

	// Leaving the page would stop the uploads (they resume if the same files
	// are added again, but that's easy to miss).
	useEffect(() => {
		if (!busy) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [busy]);

	return (
		<>
			{dragging && (
				<div
					className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-6 backdrop-blur-xs"
					ref={overlayRef}
				>
					<div className="pointer-events-none flex flex-col items-center gap-3 rounded-xl border-2 border-primary border-dashed bg-popover px-16 py-12 text-center shadow-lg">
						<UploadIcon className="size-8 text-primary" />
						<p className="font-medium">Drop files to upload</p>
						<p className="text-muted-foreground text-sm">to {dropDir}</p>
					</div>
				</div>
			)}
			<Dialog onOpenChange={onOpenChange} open={open}>
				<DialogContent className="sm:max-w-lg" data-keep-selection>
					<DialogHeader>
						<DialogTitle>Upload files</DialogTitle>
						<DialogDescription>
							Files are uploaded to {dir}. Progress shows in the corner, and you
							can keep browsing meanwhile.
						</DialogDescription>
					</DialogHeader>

					<label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm transition-colors hover:bg-muted/50">
						<UploadIcon className="size-6" />
						<span>Drop files here or click to browse</span>
						<input
							className="sr-only"
							multiple
							onChange={(e) => {
								add(e.target.files);
								e.target.value = "";
							}}
							type="file"
						/>
					</label>

					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Close
						</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{uppy && files.length > 0 && (
				<UploadPanel
					busy={busy}
					failedStatus={failedStatus.current}
					files={files}
					onCancelAll={() => uppy.cancelAll()}
					onRemove={(id) => uppy.removeFile(id)}
					onRetry={(ids) => {
						for (const id of ids) void uppy.retryUpload(id);
					}}
				/>
			)}
		</>
	);
}

type Status = "done" | "failed" | "sending" | "waiting";

function statusOf(file: File): Status {
	if (file.progress.uploadComplete) return "done";
	if (file.error) return "failed";
	// Queued files are "started" too; only ones sending bytes count.
	return file.progress.bytesUploaded ? "sending" : "waiting";
}

/**
 * The corner panel: overall progress, then every file of the batch in the
 * order added, with its status. Files added later join the same list; it
 * stays after everything finishes, until dismissed. Only the rows in view are rendered, so
 * thousands of files stay fast.
 */
function UploadPanel({
	files,
	busy,
	failedStatus,
	onRetry,
	onRemove,
	onCancelAll,
}: {
	files: File[];
	busy: boolean;
	failedStatus: Map<string, number>;
	onRetry: (ids: string[]) => void;
	onRemove: (id: string) => void;
	onCancelAll: () => void;
}) {
	const [expanded, setExpanded] = useState(true);
	const listRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	// Publishes the space the panel takes at the bottom of the screen, so
	// toasts stack above it rather than covering it (see the layout).
	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const root = document.documentElement;
		const observer = new ResizeObserver(() => {
			const gap = window.innerHeight - panel.getBoundingClientRect().bottom;
			root.style.setProperty(
				"--upload-panel-space",
				`${panel.offsetHeight + gap}px`,
			);
		});
		observer.observe(panel);
		return () => {
			observer.disconnect();
			root.style.removeProperty("--upload-panel-space");
		};
	}, []);
	// The list follows the upload in progress, except while the pointer is
	// over it (the user is looking or scrolling).
	const hovering = useRef(false);

	let done = 0;
	let bytesDone = 0;
	let bytesTotal = 0;
	let firstSending = -1;
	// Names that were already taken: expected when re-uploading a set.
	let existed = 0;
	const retryable: string[] = [];
	const failed = files.filter((f) => f.error).length;
	for (const [i, f] of files.entries()) {
		const size = f.size ?? 0;
		bytesTotal += size;
		const status = statusOf(f);
		if (status === "done") {
			done++;
			bytesDone += size;
		} else if (status === "failed") {
			const code = failedStatus.get(f.id) ?? 0;
			if (code === 409) existed++;
			if (code < 400 || code >= 500) retryable.push(f.id);
		} else {
			bytesDone += f.progress.bytesUploaded || 0;
			if (status === "sending" && firstSending < 0) firstSending = i;
		}
	}
	const waiting = files.length - done - failed;
	const percent = bytesTotal > 0 ? (bytesDone / bytesTotal) * 100 : 0;

	const title = busy
		? `Uploading ${done.toLocaleString()} of ${files.length.toLocaleString()}`
		: `${plural(done, "file")} uploaded`;
	const details = [
		busy && `${formatSize(bytesDone)} of ${formatSize(bytesTotal)}`,
		busy && waiting > 0 && `${waiting.toLocaleString()} remaining`,
		existed > 0 && `${existed.toLocaleString()} already existed`,
		failed > existed && `${(failed - existed).toLocaleString()} failed`,
	].filter(Boolean);

	const virtualizer = useVirtualizer({
		count: expanded ? files.length : 0,
		getScrollElement: () => listRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 8,
	});
	useEffect(() => {
		if (firstSending >= 0 && !hovering.current) {
			virtualizer.scrollToIndex(firstSending);
		}
	}, [firstSending, virtualizer]);

	return (
		<section
			aria-label="Uploads"
			className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
			data-keep-selection
			ref={panelRef}
		>
			<header className="flex items-center gap-3 px-4 py-3">
				{busy ? (
					<Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
				) : failed > existed ? (
					<CircleAlertIcon className="size-4 shrink-0 text-destructive" />
				) : (
					<CircleCheckIcon className="size-4 shrink-0 text-primary" />
				)}
				<div aria-live="polite" className="min-w-0 flex-1">
					<p className="truncate font-medium text-sm">{title}</p>
					{details.length > 0 && (
						<p className="truncate text-muted-foreground text-xs tabular-nums">
							{details.join(" · ")}
						</p>
					)}
				</div>
				<Button
					aria-expanded={expanded}
					onClick={() => setExpanded((e) => !e)}
					size="icon-xs"
					title={expanded ? "Hide files" : "Show files"}
					variant="ghost"
				>
					{expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
					<span className="sr-only">
						{expanded ? "Hide files" : "Show files"}
					</span>
				</Button>
				{!busy && (
					<Button
						onClick={onCancelAll}
						size="icon-xs"
						title="Dismiss"
						variant="ghost"
					>
						<XIcon />
						<span className="sr-only">Dismiss</span>
					</Button>
				)}
			</header>
			{busy && <Progress className="px-4 pb-3" value={percent} />}

			{expanded && (
				<>
					<div
						className="max-h-80 overflow-y-auto border-t"
						onPointerEnter={() => {
							hovering.current = true;
						}}
						onPointerLeave={() => {
							hovering.current = false;
						}}
						ref={listRef}
					>
						<ul
							className="relative"
							style={{ height: virtualizer.getTotalSize() }}
						>
							{virtualizer.getVirtualItems().map((item) => {
								const file = files[item.index];
								if (!file) return null;
								return (
									<UploadRow
										canRetry={retryable.includes(file.id)}
										file={file}
										key={file.id}
										onRemove={() => onRemove(file.id)}
										onRetry={() => onRetry([file.id])}
										top={item.start}
									/>
								);
							})}
						</ul>
					</div>
					{(busy || retryable.length > 0) && (
						<footer className="flex justify-end gap-2 border-t px-4 py-2">
							{retryable.length > 0 && (
								<Button
									onClick={() => onRetry(retryable)}
									size="sm"
									variant="outline"
								>
									<RotateCwIcon />
									{retryable.length > 1 ? "Retry all" : "Retry"}
								</Button>
							)}
							{busy && (
								<Button onClick={onCancelAll} size="sm" variant="ghost">
									Cancel all
								</Button>
							)}
						</footer>
					)}
				</>
			)}
		</section>
	);
}

/** One file in the panel: its status, and Cancel/Retry/Remove as they apply. */
function UploadRow({
	file,
	top,
	canRetry,
	onRetry,
	onRemove,
}: {
	file: File;
	/** Offset in the virtual list. */
	top: number;
	canRetry: boolean;
	onRetry: () => void;
	onRemove: () => void;
}) {
	const status = statusOf(file);
	const size = formatSize(file.size ?? 0);
	const percent = file.progress.percentage ?? 0;
	const detail = {
		done: `Uploaded · ${size}`,
		failed: file.error ?? "Upload failed",
		sending: `${percent}% of ${size}`,
		waiting: `Waiting · ${size}`,
	}[status];

	return (
		<li
			className="absolute inset-x-0 flex items-center gap-3 px-4"
			style={{ height: ROW_HEIGHT, top }}
		>
			{status === "done" ? (
				<CircleCheckIcon className="size-4 shrink-0 text-primary" />
			) : status === "failed" ? (
				<CircleAlertIcon className="size-4 shrink-0 text-destructive" />
			) : status === "sending" ? (
				<Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
			) : (
				<FileIcon className="size-4 shrink-0 text-muted-foreground" />
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="truncate text-sm">{file.name}</p>
				{status === "sending" ? (
					<Progress aria-label={detail} value={percent} />
				) : (
					<p
						className={cn(
							"truncate text-xs tabular-nums",
							status === "failed"
								? "text-destructive"
								: "text-muted-foreground",
						)}
						title={detail}
					>
						{detail}
					</p>
				)}
			</div>
			{status === "sending" && (
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{percent}%
				</span>
			)}
			{canRetry && (
				<Button
					aria-label={`Retry ${file.name}`}
					onClick={onRetry}
					size="icon-xs"
					title="Retry"
					variant="ghost"
				>
					<RotateCwIcon />
				</Button>
			)}
			{status !== "done" && (
				<Button
					aria-label={
						status === "failed"
							? `Remove ${file.name} from the list`
							: `Cancel ${file.name}`
					}
					onClick={onRemove}
					size="icon-xs"
					title={status === "failed" ? "Remove from list" : "Cancel"}
					variant="ghost"
				>
					<XIcon />
				</Button>
			)}
		</li>
	);
}
