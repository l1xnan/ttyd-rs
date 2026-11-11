import type { IDisposable } from '@xterm/xterm';

export interface TransferControllerOptions {
    enabled: boolean;
    /** False for read-only replays, disconnected sockets and disabled stdin. */
    canWrite: () => boolean;
    onRequest: (files: File[]) => void;
    element: EventTarget;
}

/**
 * Capture-phase drop listener for HTTP uploads. Stopping propagation here
 * keeps the trzsz drop listener registered on the same element from also
 * firing. When the feature is off nothing is registered and trzsz behaves
 * exactly as before.
 */
export class TransferController implements IDisposable {
    private disposables: Array<() => void> = [];

    constructor(private options: TransferControllerOptions) {
        this.attachDrop(options.element);
    }

    dispose(): void {
        for (const dispose of this.disposables) dispose();
        this.disposables.length = 0;
    }

    private attachDrop(element: EventTarget) {
        if (!this.options.enabled) return;

        const onDragOver = (event: Event) => event.preventDefault();
        const onDrop = (event: Event) => {
            const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
            if (files.length === 0 || !this.options.canWrite()) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.options.onRequest(files);
        };

        element.addEventListener('dragover', onDragOver, true);
        element.addEventListener('drop', onDrop, true);
        this.disposables.push(() => {
            element.removeEventListener('dragover', onDragOver, true);
            element.removeEventListener('drop', onDrop, true);
        });
    }
}
