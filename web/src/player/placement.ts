import type { Item } from '@shared/protocol.ts';
import { signal } from '@preact/signals';

/** Element a screen offers as the video's preview area (the Live screen's side panel); the player sits there in mini mode. */
export const previewBox = signal<HTMLElement | null>(null);

/** The channel list on screen: the numbers next to channels are positions in it, so typed digits pick from it. */
// cat: a provider category (positions past what's loaded are fetched from it); none for Favourites / Recent.
export const numbered = signal<{ at: (i: number) => Item | undefined; cat?: string } | null>(null);
