import { describe, expect, it, vi } from 'vitest';
import { TransferController, type TransferControllerOptions } from './controller';

function options(overrides: Partial<TransferControllerOptions> = {}): TransferControllerOptions {
    return {
        enabled: true,
        canWrite: () => true,
        onRequest: vi.fn(),
        element: document.createElement('div'),
        ...overrides,
    };
}

function dropEvent(): Event {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: { files: [new File(['x'], 'x.txt')] },
    });
    return event;
}

describe('TransferController', () => {
    it('captures drops so the trzsz bubble listener never runs', () => {
        const element = document.createElement('div');
        const bubble = vi.fn();
        element.addEventListener('drop', bubble);
        const opts = options({ element });
        const controller = new TransferController(opts);

        element.dispatchEvent(dropEvent());
        expect(bubble).not.toHaveBeenCalled();
        expect(opts.onRequest).toHaveBeenCalledWith(expect.any(Array));
        controller.dispose();
    });

    it('leaves trzsz drops alone when the feature is off', () => {
        const element = document.createElement('div');
        const bubble = vi.fn();
        element.addEventListener('drop', bubble);
        const opts = options({ element, enabled: false });
        const controller = new TransferController(opts);

        element.dispatchEvent(dropEvent());
        expect(bubble).toHaveBeenCalledOnce();
        expect(opts.onRequest).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('removes its listeners on dispose', () => {
        const element = document.createElement('div');
        const bubble = vi.fn();
        element.addEventListener('drop', bubble);
        const controller = new TransferController(options({ element }));
        controller.dispose();

        element.dispatchEvent(dropEvent());
        expect(bubble).toHaveBeenCalledOnce();
    });
});
