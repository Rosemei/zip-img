import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // If you need to deploy to a sub-path on Vercel, set base: '/subpath/'
  // base: '/',
  build: {
    target: 'es2020'
  }
})
