import { h, render } from 'preact';
import { App } from './components/app';
import './style/index.scss';

if (import.meta.env.DEV) {
    void import('preact/debug');
}

const container = document.getElementById('app');
if (container) {
    render(<App />, container);
}
