import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the build works from any path (GitHub Pages, Vercel, a plain folder)
export default defineConfig({ plugins: [react()], base: './' });
