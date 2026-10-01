// The File Captain mark (lucide "ship" on the primary green tile), written as
// plain elements so next/og can render it for the favicon and social cards.
// Colors are the hex equivalents of --primary / --primary-foreground.
export const BRAND_GREEN = "#15803d";
export const BRAND_FOREGROUND = "#f0fdf4";

export function LogoMark({
	size,
	rounded = true,
}: {
	size: number;
	rounded?: boolean;
}) {
	return (
		<div
			style={{
				width: size,
				height: size,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: BRAND_GREEN,
				borderRadius: rounded ? size * 0.22 : 0,
			}}
		>
			{/* biome-ignore lint/a11y/noSvgWithoutTitle: next/og draws <title> as visible text; this only renders to images */}
			<svg
				fill="none"
				height={size * 0.6}
				stroke={BRAND_FOREGROUND}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				viewBox="0 0 24 24"
				width={size * 0.6}
				xmlns="http://www.w3.org/2000/svg"
			>
				<path d="M12 2v2" />
				<path d="M12 9.189V13" />
				<path d="M19 12V6a2 2 0 00-2-2H7a2 2 0 00-2 2v6" />
				<path d="M19.38 19A11.6 11.6 0 0021 13l-8.188-3.639a2 2 0 00-1.624 0L3 13.001a11.6 11.6 0 002.81 7.76" />
				<path d="M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
			</svg>
		</div>
	);
}
