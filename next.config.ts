import type { NextConfig } from 'next';

// Volledig statische export: de app draait in de browser en kan op elke statische host staan
// (Cloudflare Pages, Netlify, GitHub Pages, Vercel, ...). Zet NEXT_PUBLIC_BASE_PATH bij hosting in een submap.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
