"use client";

import Uppy, { type UppyFile } from "@uppy/core";
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

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "~/components/ui/dialog";
import { Progress } from "~/components/ui/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";

type Meta = { dir?: string; name: string; type?: string };
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
 * mounted so uploads keep going while the dialog is closed.
 */
export function Uploader({
	dir,
	open,
	onOpenChange,
	onUploaded,
	showButton,
}: {
	dir: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onUploaded: (names: string[]) => void;
	showButton: boolean;
}) {
	const [uppy, setUppy] = useState<Uppy<Meta, Record<string, never>> | null>(
		null,
	);
	const [files, setFiles] = useState<File[]>([]);
	const [dragging, setDragging] = useState(false);
	// Read when a file is added, so files keep the folder they were added in.
	const dirRef = useRef(dir);
	dirRef.current = dir;
	const onUploadedRef = useRef(onUploaded);
	onUploadedRef.current = onUploaded;

	useEffect(() => {
		const instance = new Uppy<Meta, Record<string, never>>({
			autoProceed: true,
			onBeforeFileAdded: (file) => {
				// Files re-added for a retry keep their original folder.
				const target = file.meta.dir ?? dirRef.current;
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

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			{showButton && (
				<DialogTrigger render={<Button disabled={!uppy} />}>
					<UploadIcon />
					{active.length > 0 ? `Uploading ${active.length}…` : "Upload"}
				</DialogTrigger>
			)}
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Upload files</DialogTitle>
					<DialogDescription>
						Files are uploaded to {dir}. You can close this window while they
						upload.
					</DialogDescription>
				</DialogHeader>

				{files.length === 0 && (
					<label
						className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm transition-colors hover:bg-muted/50 ${dragging ? "border-primary bg-muted/50" : ""}`}
						onDragLeave={() => setDragging(false)}
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDrop={(e) => {
							e.preventDefault();
							setDragging(false);
							add(e.dataTransfer.files);
						}}
					>
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
