"use client";

import { useRef } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";

export type Message = { title: string; message: string };

/** A dialog that reports something (usually a failure) and is dismissed with OK. */
export function MessageDialog({
	message,
	onClose,
}: {
	message: Message | null;
	onClose: () => void;
}) {
	// Keeps the text while the dialog animates closed.
	const shown = useRef(message);
	if (message) shown.current = message;
	return (
		<AlertDialog
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
			open={message !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{shown.current?.title}</AlertDialogTitle>
					<AlertDialogDescription>
						{shown.current?.message}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogAction autoFocus onClick={onClose}>
						OK
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
