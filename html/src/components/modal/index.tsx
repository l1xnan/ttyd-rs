import { h, Component, ComponentChildren } from 'preact';

import './modal.css';

interface Props {
    show: boolean;
    children: ComponentChildren;
    onCancel?: () => void;
    /** `dark` follows the workspace palette; the default is the light ZMODEM box. */
    variant?: 'light' | 'dark';
}

export class Modal extends Component<Props> {
    constructor(props: Props) {
        super(props);
    }

    render({ show, children, onCancel, variant = 'light' }: Props) {
        return (
            show && (
                <div className={`modal${variant === 'dark' ? ' modal--dark' : ''}`}>
                    <div className="modal-background" onClick={onCancel} />
                    <div className="modal-content">
                        <div className="box">
                            {children}
                            {onCancel && (
                                <button type="button" className="modal-cancel" onClick={onCancel}>
                                    Cancel
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )
        );
    }
}
