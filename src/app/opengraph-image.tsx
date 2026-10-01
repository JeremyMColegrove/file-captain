import { ImageResponse } from "next/og";

import { BRAND_GREEN, LogoMark } from "~/app/_components/logo-mark";

export const alt = "File Captain — Ultra simple file browser";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 40,
				background: "#ffffff",
				borderTop: `16px solid ${BRAND_GREEN}`,
			}}
		>
			<LogoMark size={200} />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 12,
				}}
			>
				<div style={{ fontSize: 88, color: "#0a0a0a" }}>File Captain</div>
				<div style={{ fontSize: 40, color: "#525252" }}>
					Ultra simple file browser
				</div>
			</div>
		</div>,
		size,
	);
}
