import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages alt klasörde yayınlar (/Butce-Kontrolu/); Netlify/yerel geliştirmede kök (/)
export default defineConfig({ base: process.env.VITE_BASE ?? '/', plugins: [react()] });
