import { ImageResponse } from "next/og";

import { LogoMark } from "~/app/_components/logo-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS rounds the corners itself, so fill the whole square.
export default function AppleIcon() {
	return new ImageResponse(<LogoMark rounded={false} size={180} />, size);
}
