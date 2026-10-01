"use client";

import { Loader2Icon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
	return (
		<Sonner
			className="toaster group"
			icons={{ loading: <Loader2Icon className="size-4 animate-spin" /> }}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius)",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
}

export { Toaster };
