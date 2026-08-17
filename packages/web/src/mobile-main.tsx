import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@zedcode/ui/lib/api/types';
import '@zedcode/ui/index.css';
import '@zedcode/ui/styles/fonts';

declare global {
  interface Window {
    __ZEDCODE_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__ZEDCODE_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@zedcode/ui/apps/renderMobileApp')
  .then(({ renderMobileApp }) => {
    renderMobileApp(window.__ZEDCODE_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
