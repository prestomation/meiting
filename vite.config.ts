import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Base path: '/' for Cloudflare Pages (root deploy)
// If deploying to GitHub Pages at /meiting/, change base to '/meiting/'
export default defineConfig({
  plugins: [react()],
  base: '/',
})
