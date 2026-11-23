import type { ArchCanvasApi } from '../preload/index.js';

declare global {
  interface Window {
    archcanvas: ArchCanvasApi;
  }
}

export {};
