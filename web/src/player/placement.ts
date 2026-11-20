import { signal } from '@preact/signals';

/** Element a screen offers as the video's preview area (the Live screen's side panel); the player sits there in mini mode. */
export const previewBox = signal<HTMLElement | null>(null);
