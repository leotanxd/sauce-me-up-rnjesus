import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Dev only: forward /api to the FastAPI wrapper (backend/api.py on :8000)
  server: { proxy: { "/api": "http://localhost:8000" } },
})
