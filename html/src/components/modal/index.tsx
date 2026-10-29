import { h, Component, ComponentChildren } from 'preact';

import './modal.scss';

interface Props {
    show: boolean;
    children: ComponentChildren;
    onCancel?: () => void;
}

export class Modal extends Component<Props> {
    constructor(props: Props) {
        super(props);
    }

    render({ show, children, onCancel }: Props) {
        return (
            show && (
                <div className="modal">
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
