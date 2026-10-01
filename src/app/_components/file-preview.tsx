"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
	DownloadIcon,
	Loader2Icon,
	type LucideIcon,
	MusicIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogPortal } from "~/components/ui/dialog";
import { type Entry, join, previewUrl, thumbnailUrl } from "~/lib/api-client";
import { previewOf } from "~/lib/file-types";
import { formatShortDate, formatSize } from "~/lib/format";
import { cn } from "~/lib/utils";
import { TypeIcon } from "./type-icon";

/** Text previews show at most this much of the file. */
const TEXT_LIMIT = 1024 * 1024;

/**
 * A full-screen viewer for a file: its content fills the screen (see
 * previewOf), with the name and actions in a slim bar above. Files that can't
 * be previewed show their icon and a Download button. ← and → step through
 * the folder's other files.
 */
export function FilePreview({
	dir,
	entries,
	entry,
	onShow,
	onClose,
	onDownload,
}: {
	/** The folder the file is in. */
	dir: string;
	/** The folder's files, in listing order. */
	entries: Entry[];
	entry: Entry | null;
	onShow: (entry: Entry) => void;
	onClose: () => void;
	onDownload: (entry: Entry) => void;
}) {
	// Keeps the content while the viewer animates closed.
	const shown = useRef(entry);
	if (entry) shown.current = entry;
	const file = shown.current;
	const popupRef = useRef<HTMLDivElement>(null);

	const index = file ? entries.findIndex((e) => e.name === file.name) : -1;
	const prev = index > 0 ? entries[index - 1] : undefined;
	const next = index >= 0 ? entries[index + 1] : undefined;

	function onKeyDown(e: React.KeyboardEvent) {
		// Focused players use the arrow keys to seek.
		if ((e.target as Element).closest("video, audio")) return;
		const target =
			e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : null;
		if (!target) return;
		e.preventDefault();
		onShow(target);
	}

	return (
		<Dialog
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
			open={entry !== null}
		>
			<DialogPortal>
				{/* The popup is its own dark backdrop: a separate overlay faded on a
				    different timer, so closing flashed. */}
				<DialogPrimitive.Popup
					className="data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 flex flex-col bg-neutral-950/95 text-white outline-none duration-150 data-closed:animate-out data-open:animate-in"
					data-keep-selection
					initialFocus={popupRef}
					onKeyDown={onKeyDown}
					ref={popupRef}
				>
					{file && (
						<>
							<header className="flex items-center gap-3 bg-black py-2 pr-2 pl-4">
								<TypeIcon className="size-5 shrink-0" name={file.name} />
								<div className="min-w-0 flex-1">
									<DialogPrimitive.Title className="truncate font-medium text-sm">
										{file.name}
									</DialogPrimitive.Title>
									<p className="truncate text-white/60 text-xs">
										{formatSize(file.size)} · {formatShortDate(file.mtime)}
										{entries.length > 1 &&
											` · ${index + 1} of ${entries.length}`}
									</p>
								</div>
								<BarButton
									icon={DownloadIcon}
									label="Download"
									onClick={() => onDownload(file)}
								/>
								<DialogPrimitive.Close
									render={<BarButton icon={XIcon} label="Close" />}
								/>
							</header>

							<div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-4 sm:px-8">
								<Content
									dir={dir}
									entry={file}
									key={file.name}
									onDownload={() => onDownload(file)}
								/>
							</div>
						</>
					)}
				</DialogPrimitive.Popup>
			</DialogPortal>
		</Dialog>
	);
}

/** The file's content, by kind. Keyed by file, so each one starts fresh. */
function Content({
	dir,
	entry,
	onDownload,
}: {
	dir: string;
	entry: Entry;
	onDownload: () => void;
}) {
	const path = join(dir, entry.name);
	const src = previewUrl(path, entry);
	const [failed, setFailed] = useState(false);
	const fail = () => setFailed(true);

	if (failed) {
		return (
			<Unavailable
				message="This file can't be shown in your browser"
				name={entry.name}
				onDownload={onDownload}
			/>
		);
	}
	switch (previewOf(entry.name)?.kind) {
		case "image":
			return (
				<ImageView
					name={entry.name}
					onError={fail}
					src={src}
					thumbnail={entry.thumbnail ? thumbnailUrl(path, entry) : null}
				/>
			);
		case "video":
			return (
				// biome-ignore lint/a11y/useMediaCaption: user files have no captions
				<video
					autoPlay
					className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
					controls
					onError={fail}
					// Plays only the audio when the browser lacks the video codec
					// (e.g. HEVC in an .mkv); show the fallback instead.
					onLoadedMetadata={(e) => {
						if (e.currentTarget.videoWidth === 0) fail();
					}}
					playsInline
					src={src}
				/>
			);
		case "audio":
			return (
				<div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl bg-white/5 p-8 shadow-2xl ring-1 ring-white/10">
					<div className="flex size-36 items-center justify-center rounded-xl bg-linear-to-br from-pink-500/40 to-purple-600/40">
						<MusicIcon className="size-14 text-white/80" strokeWidth={1.5} />
					</div>
					<p className="w-full truncate text-center font-medium">
						{entry.name}
					</p>
					{/* biome-ignore lint/a11y/useMediaCaption: user files have no captions */}
					<audio
						autoPlay
						className="w-full"
						controls
						onError={fail}
						src={src}
					/>
				</div>
			);
		case "text":
			return (
				<TextView
					name={entry.name}
					onDownload={onDownload}
					size={entry.size}
					src={src}
				/>
			);
		default:
			return (
				<Unavailable
					message="No preview available"
					name={entry.name}
					onDownload={onDownload}
				/>
			);
	}
}

/**
 * The full image, fading in over its (already cached) thumbnail scaled up and
 * blurred, so something shows straight away even on a slow disk.
 */
function ImageView({
	name,
	src,
	thumbnail,
	onError,
}: {
	name: string;
	src: string;
	thumbnail: string | null;
	onError: () => void;
}) {
	const [loaded, setLoaded] = useState(false);
	return (
		<div className="relative size-full">
			{thumbnail && !loaded && (
				// biome-ignore lint/performance/noImgElement: our API serves the files as-is
				<img
					alt=""
					className="absolute inset-0 size-full scale-95 object-contain opacity-60 blur-xl"
					src={thumbnail}
				/>
			)}
			{!loaded && (
				<Loader2Icon className="absolute inset-0 m-auto size-6 animate-spin text-white/70" />
			)}
			{/* biome-ignore lint/performance/noImgElement: our API serves the files as-is */}
			<img
				alt={name}
				className={cn(
					"absolute inset-0 size-full object-scale-down drop-shadow-2xl transition-opacity duration-300",
					loaded ? "opacity-100" : "opacity-0",
				)}
				onError={onError}
				onLoad={() => setLoaded(true)}
				src={src}
			/>
		</div>
	);
}

/** The start of a text file (up to TEXT_LIMIT), on a page-like sheet. */
function TextView({
	name,
	src,
	size,
	onDownload,
}: {
	name: string;
	src: string;
	size: number;
	onDownload: () => void;
}) {
	const [result, setResult] = useState<{ text: string } | { error: string }>();
	useEffect(() => {
		const controller = new AbortController();
		fetch(src, {
			headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` },
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok) {
					const data = await res.json().catch(() => null);
					throw new Error(data?.error?.message ?? "Couldn't load the file.");
				}
				const bytes = new Uint8Array(await res.arrayBuffer());
				// Text never contains NUL bytes; binary files nearly always do.
				if (bytes.includes(0)) {
					setResult({ error: "This file doesn't look like text" });
				} else {
					setResult({ text: new TextDecoder().decode(bytes) });
				}
			})
			.catch((err: Error) => {
				if (!controller.signal.aborted) setResult({ error: err.message });
			});
		return () => controller.abort();
	}, [src]);

	if (!result) {
		return <Loader2Icon className="size-6 animate-spin text-white/70" />;
	}
	if ("error" in result) {
		return (
			<Unavailable message={result.error} name={name} onDownload={onDownload} />
		);
	}
	return (
		<div className="flex size-full max-w-5xl flex-col overflow-hidden rounded-xl bg-background text-foreground shadow-2xl ring-1 ring-white/10">
			{result.text ? (
				<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed">
					{result.text}
				</pre>
			) : (
				<p className="m-auto text-muted-foreground">This file is empty.</p>
			)}
			{size > TEXT_LIMIT && (
				<p className="border-t bg-muted/50 px-6 py-2 text-muted-foreground text-xs">
					Showing the first {formatSize(TEXT_LIMIT)} of {formatSize(size)}.
					Download the file to see all of it.
				</p>
			)}
		</div>
	);
}

/** In place of content that can't be shown: the file's icon, why, and Download. */
function Unavailable({
	name,
	message,
	onDownload,
}: {
	name: string;
	message: string;
	onDownload: () => void;
}) {
	return (
		<div className="flex flex-col items-center gap-5 rounded-2xl bg-neutral-900 px-12 py-10 text-center ring-1 ring-neutral-800">
			<TypeIcon className="size-20" name={name} strokeWidth={1} />
			<p className="text-white">{message}</p>
			<Button onClick={onDownload} variant="secondary">
				<DownloadIcon />
				Download
			</Button>
		</div>
	);
}

function BarButton({
	icon: Icon,
	label,
	...props
}: { icon: LucideIcon; label: string } & React.ComponentProps<typeof Button>) {
	return (
		<Button
			className="text-white/80 hover:bg-white/10 hover:text-white aria-expanded:bg-white/10 dark:hover:bg-white/10"
			size="icon"
			title={label}
			variant="ghost"
			{...props}
		>
			<Icon />
			<span className="sr-only">{label}</span>
		</Button>
	);
}
