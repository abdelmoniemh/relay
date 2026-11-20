import './polyfills.ts';
import { render } from 'preact';
import { isTizen, isMobile } from './env.ts';
import { App } from './App.tsx';
import { installKeys } from './keys.ts';
import { applyLang } from './i18n.ts';
import './mediasession.ts';
import './styles.css';

document.documentElement.classList.add(isTizen ? 'tv' : isMobile ? 'phone' : 'desktop');
applyLang();
installKeys();
render(<App />, document.getElementById('app')!);
