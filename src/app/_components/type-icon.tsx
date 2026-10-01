import type { LucideIcon } from "lucide-react";

import { fileType, genericFile } from "~/lib/file-types";
import { cn } from "~/lib/utils";

/** A file's type icon (PDF, spreadsheet, ...), colored by type. */
export function TypeIcon({
	name,
	className,
	...props
}: { name: string } & React.ComponentProps<LucideIcon>) {
	const { icon: Icon, className: color } = fileType(name) ?? genericFile;
	return <Icon className={cn(color, className)} {...props} />;
}
