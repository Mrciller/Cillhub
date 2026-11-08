import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// livekit-client is a lazily loaded chunk of about 570 kB; only voice users download it. The main bundle is ~700 kB with v4 (incl. the German dictionary).
export default defineConfig({ plugins: [react()], build: { chunkSizeWarningLimit: 800 } })
