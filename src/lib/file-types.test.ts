import { describe, expect, it } from "vitest";
import { fileType, previewOf } from "./file-types";

const label = (name: string) => fileType(name)?.label ?? null;

describe("fileType", () => {
	it("maps common extensions to their type", () => {
		expect(label("photo.jpg")).toBe("Image");
		expect(label("report.pdf")).toBe("PDF document");
		expect(label("letter.docx")).toBe("Document");
		expect(label("budget.xlsx")).toBe("Spreadsheet");
		expect(label("deck.pptx")).toBe("Presentation");
		expect(label("notes.txt")).toBe("Text");
		expect(label("app.ts")).toBe("Source code");
		expect(label("config.yaml")).toBe("Data");
		expect(label("backup.zip")).toBe("Archive");
		expect(label("song.mp3")).toBe("Audio");
		expect(label("clip.mp4")).toBe("Video");
		expect(label("book.epub")).toBe("E-book");
		expect(label("installer.dmg")).toBe("Disk image or installer");
		expect(label("font.woff2")).toBe("Font");
	});

	it("ignores extension case", () => {
		expect(label("IMG_0001.JPG")).toBe("Image");
	});

	it("uses the last extension", () => {
		expect(label("site.tar.gz")).toBe("Archive");
	});

	it("returns null for unknown, missing, or dotfile-only extensions", () => {
		expect(label("data.xyz")).toBeNull();
		expect(label("Makefile")).toBeNull();
		expect(label(".env")).toBeNull();
		expect(label("trailing.")).toBeNull();
	});
});

describe("previewOf", () => {
	const kind = (name: string) => previewOf(name)?.kind ?? null;

	it("previews browser-native images, video, audio and text", () => {
		expect(kind("photo.JPG")).toBe("image");
		expect(kind("clip.mp4")).toBe("video");
		expect(kind("song.flac")).toBe("audio");
		expect(kind("notes.md")).toBe("text");
		expect(kind("app.ts")).toBe("text");
		expect(kind("data.csv")).toBe("text");
	});

	it("never previews types that can run script", () => {
		expect(previewOf("logo.svg")).toBeNull();
		expect(previewOf("report.pdf")).toBeNull();
		expect(previewOf("README")).toBeNull();
	});

	it("serves text, code and markup as plain text", () => {
		expect(previewOf("page.html")?.mime).toBe("text/plain; charset=utf-8");
		expect(previewOf("feed.xml")?.mime).toBe("text/plain; charset=utf-8");
	});

	it("leaves formats browsers can't show to download", () => {
		expect(previewOf("IMG_1.heic")).toBeNull();
		expect(previewOf("shot.cr2")).toBeNull();
		expect(previewOf("letter.docx")).toBeNull();
	});
});
