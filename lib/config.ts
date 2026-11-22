/** Base path for hosting in a subfolder (for example, GitHub Pages). Empty when hosted at the domain root. */
export const basePath: string = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Prefixes a public path (such as "/sw.js") with the base path. */
export const asset = (path: string): string => `${basePath}${path}`;
