import {
	FileArchiveIcon,
	FileBoxIcon,
	FileChartPieIcon,
	FileCodeIcon,
	FileIcon,
	FileImageIcon,
	FileJsonIcon,
	FileMusicIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FileTypeIcon,
	FileVideoIcon,
	type LucideIcon,
} from "lucide-react";

export type FileType = {
	icon: LucideIcon;
	/** Tailwind color classes for the icon. */
	className: string;
	/** Shown as "Kind" in Get Info. */
	label: string;
};

const muted = "text-muted-foreground";

const types = {
	image: {
		icon: FileImageIcon,
		className: "text-purple-600 dark:text-purple-400",
		label: "Image",
		exts: "jpg jpeg png gif webp avif svg bmp ico tif tiff heic heif raw cr2 nef dng psd",
	},
	pdf: {
		icon: FileTextIcon,
		className: "text-red-600 dark:text-red-400",
		label: "PDF document",
		exts: "pdf",
	},
	document: {
		icon: FileTextIcon,
		className: "text-blue-600 dark:text-blue-400",
		label: "Document",
		exts: "doc docx odt rtf pages",
	},
	spreadsheet: {
		icon: FileSpreadsheetIcon,
		className: "text-green-600 dark:text-green-400",
		label: "Spreadsheet",
		exts: "xls xlsx xlsm ods numbers csv tsv",
	},
	presentation: {
		icon: FileChartPieIcon,
		className: "text-orange-600 dark:text-orange-400",
		label: "Presentation",
		exts: "ppt pptx odp key",
	},
	text: {
		icon: FileTypeIcon,
		className: muted,
		label: "Text",
		exts: "txt md markdown log rst nfo",
	},
	code: {
		icon: FileCodeIcon,
		className: "text-sky-600 dark:text-sky-400",
		label: "Source code",
		exts: "js jsx ts tsx mjs cjs py rb go rs java kt c h cpp hpp cs php swift sh bash zsh ps1 bat html htm css scss sql vue svelte",
	},
	data: {
		icon: FileJsonIcon,
		className: "text-yellow-600 dark:text-yellow-400",
		label: "Data",
		exts: "json yaml yml toml xml ini env conf cfg",
	},
	archive: {
		icon: FileArchiveIcon,
		className: "text-amber-700 dark:text-amber-500",
		label: "Archive",
		exts: "zip tar gz tgz bz2 xz 7z rar zst",
	},
	audio: {
		icon: FileMusicIcon,
		className: "text-pink-600 dark:text-pink-400",
		label: "Audio",
		exts: "mp3 wav flac aac ogg m4a opus wma aiff",
	},
	video: {
		icon: FileVideoIcon,
		className: "text-indigo-600 dark:text-indigo-400",
		label: "Video",
		exts: "mp4 mkv mov avi webm m4v wmv flv",
	},
	ebook: {
		icon: FileTextIcon,
		className: "text-teal-600 dark:text-teal-400",
		label: "E-book",
		exts: "epub mobi azw3",
	},
	package: {
		icon: FileBoxIcon,
		className: muted,
		label: "Disk image or installer",
		exts: "iso dmg img apk deb rpm msi exe appimage",
	},
	font: {
		icon: FileTypeIcon,
		className: muted,
		label: "Font",
		exts: "ttf otf woff woff2",
	},
};

const byExt = new Map<string, FileType>();
for (const { exts, ...type } of Object.values(types)) {
	for (const ext of exts.split(" ")) byExt.set(ext, type);
}

/** The icon, color and label for a file, from its extension. Null if unknown. */
export function fileType(name: string): FileType | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return byExt.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** Shown when a file's type is unknown. */
export const genericFile: FileType = {
	icon: FileIcon,
	className: muted,
	label: "File",
};

export type PreviewKind = "image" | "video" | "audio" | "text";
export type Preview = { kind: PreviewKind; mime: string };

/**
 * Files the browser can show inline, and the Content-Type to serve them with.
 * Security-critical: anything served inline runs on our origin, so this only
 * lists types that can't carry script (no SVG, HTML or PDF). Text, code and
 * data are always served as text/plain, so the browser never renders them.
 */
const previews = new Map<string, Preview>();
const addPreviews = (kind: PreviewKind, mimes: Record<string, string>) => {
	for (const [ext, mime] of Object.entries(mimes)) {
		previews.set(ext, { kind, mime });
	}
};
addPreviews("image", {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
});
addPreviews("video", {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
});
addPreviews("audio", {
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	flac: "audio/flac",
});
for (const ext of [
	...types.text.exts.split(" "),
	...types.code.exts.split(" "),
	...types.data.exts.split(" "),
	"csv",
	"tsv",
]) {
	previews.set(ext, { kind: "text", mime: "text/plain; charset=utf-8" });
}

/** How a file can be previewed in the browser, from its extension. Null if it can't. */
export function previewOf(name: string): Preview | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return previews.get(name.slice(dot + 1).toLowerCase()) ?? null;
}
