import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Base path: '/' for Cloudflare Pages (root deploy at meiting.pages.dev)
export default defineConfig({
  plugins: [react()],
  base: '/',
})
