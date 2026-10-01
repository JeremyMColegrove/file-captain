"use client";

import Uppy, { type UppyFile } from "@uppy/core";
import DropTarget from "@uppy/drop-target";
import Tus from "@uppy/tus";
import {
	CircleAlertIcon,
	CircleCheckIcon,
	FileIcon,
	RotateCwIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";

type Meta = {
	dir?: string;
	name: string;
	type?: string;
	/** Set by DropTarget for files inside a dropped folder, e.g. docs/a.pdf. */
	relativePath?: string | null;
};
type File = UppyFile<Meta, Record<string, never>>;

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

/**
 * Uploads into `dir` (a virtual path like /shared/photos) over tus. Stays
 * mounted so uploads keep going while the dialog is closed or the folder
 * changes. While `dropDir` is set, files dropped anywhere on the page upload
 * there.
 */
export function Uploader({
	dir,
	dropDir,
	open,
	onOpenChange,
	onUploaded,
	onBusyChange,
	onDropped,
}: {
	dir: string;
	/** The writable folder on screen, or null when dropping isn't allowed. */
	dropDir: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onUploaded: (names: string[]) => void;
	/** Called with true while any upload is in progress. */
	onBusyChange: (busy: boolean) => void;
	/** Called after files are dropped on the page. */
	onDropped: () => void;
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
	const onDroppedRef = useRef(onDropped);
	onDroppedRef.current = onDropped;
	// Set when a dropped folder's contents were skipped, reported on drop.
	const skippedFolder = useRef(false);
	const onUploadedRef = useRef(onUploaded);
	onUploadedRef.current = onUploaded;

	useEffect(() => {
		const instance = new Uppy<Meta, Record<string, never>>({
			autoProceed: true,
			onBeforeFileAdded: (file) => {
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
				return {
					...file,
					meta: { ...file.meta, dir: target },
					tus: { endpoint: `/api/upload/${encodeURIComponent(folder)}` },
				};
			},
		}).use(Tus, {
			endpoint: "/api/upload",
			chunkSize: 50 * 1024 * 1024,
			retryDelays: [0, 1000, 3000, 5000],
			// Conflicts and permission errors won't fix themselves.
			onShouldRetry: (err, _attempt, _options, next) => {
				const status = err.originalResponse?.getStatus() ?? 0;
				return status >= 400 && status < 500 ? false : next(err);
			},
			removeFingerprintOnSuccess: true,
		});
		instance.on("state-update", () => setFiles(instance.getFiles()));
		// Replace tus' long technical message with the server's own.
		instance.on("upload-error", (file, err, response) => {
			if (file) {
				instance.setFileState(file.id, {
					error: errorMessage(response, err.message),
				});
			}
		});
		instance.on("complete", (result) => {
			const names = (result.successful ?? []).map((f) => f.name ?? "file");
			if (names.length > 0) onUploadedRef.current(names);
		});
		setUppy(instance);
		return () => instance.destroy();
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
				onDroppedRef.current();
			},
		});
		return () => {
			const plugin = uppy.getPlugin("DropTarget");
			if (plugin) uppy.removePlugin(plugin);
			setDragging(false);
		};
	}, [uppy, droppable]);

	// Opening the dialog starts fresh: finished uploads are dropped so the drop
	// area comes back. It is hidden while any upload is listed.
	useEffect(() => {
		if (!open || !uppy) return;
		for (const f of uppy.getFiles()) {
			if (f.progress.uploadComplete) uppy.removeFile(f.id);
		}
	}, [open, uppy]);

	function add(list: FileList | null) {
		for (const data of Array.from(list ?? [])) {
			try {
				uppy?.addFile({ name: data.name, type: data.type, data });
			} catch {
				// Uppy rejects files already in the list; nothing to do.
			}
		}
	}

	const active = files.filter(
		(f) => f.progress.uploadStarted && !f.progress.uploadComplete && !f.error,
	);
	const finished = files.filter((f) => f.progress.uploadComplete);
	const busy = active.length > 0;
	const onBusyChangeRef = useRef(onBusyChange);
	onBusyChangeRef.current = onBusyChange;
	useEffect(() => {
		onBusyChangeRef.current(busy);
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
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Upload files</DialogTitle>
						<DialogDescription>
							Files are uploaded to {dir}. You can close this window while they
							upload.
						</DialogDescription>
					</DialogHeader>

					{files.length === 0 && (
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
					)}

					{files.length > 0 && (
						<ul className="flex max-h-72 flex-col gap-3 overflow-y-auto">
							{files.map((file) => (
								<UploadRow
									file={file}
									key={file.id}
									onRemove={() => uppy?.removeFile(file.id)}
									onRetry={() => void uppy?.retryUpload(file.id)}
								/>
							))}
						</ul>
					)}

					<DialogFooter>
						{finished.length > 0 && (
							<Button
								onClick={() => {
									for (const f of finished) uppy?.removeFile(f.id);
								}}
								variant="outline"
							>
								Clear finished
							</Button>
						)}
						<DialogClose render={<Button />}>Close</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function UploadRow({
	file,
	onRemove,
	onRetry,
}: {
	file: File;
	onRemove: () => void;
	onRetry: () => void;
}) {
	const done = file.progress.uploadComplete;

	return (
		<li className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2 text-sm">
				{file.error ? (
					<Tooltip>
						<TooltipTrigger
							aria-label={file.error}
							render={<span className="flex shrink-0" />}
						>
							<CircleAlertIcon className="size-4 text-destructive" />
						</TooltipTrigger>
						<TooltipContent>{file.error}</TooltipContent>
					</Tooltip>
				) : done ? (
					<CircleCheckIcon className="size-4 shrink-0 text-primary" />
				) : (
					<FileIcon className="size-4 shrink-0 text-muted-foreground" />
				)}
				<span className="min-w-0 flex-1 truncate">{file.name}</span>
				{!file.error && (
					<span className="text-muted-foreground text-xs tabular-nums">
						{done ? "Done" : `${file.progress.percentage ?? 0}%`}
					</span>
				)}
				{file.error && (
					<Button
						aria-label="Retry"
						onClick={onRetry}
						size="icon-xs"
						title="Retry"
						variant="ghost"
					>
						<RotateCwIcon />
					</Button>
				)}
				<Button
					aria-label={done ? "Remove from list" : "Cancel"}
					onClick={onRemove}
					size="icon-xs"
					title={done ? "Remove from list" : "Cancel"}
					variant="ghost"
				>
					<XIcon />
				</Button>
			</div>
			<Progress value={file.progress.percentage ?? 0} />
		</li>
	);
}
