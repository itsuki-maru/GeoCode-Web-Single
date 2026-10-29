import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vite の設定項目: https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: "./",
  server: { fs: { allow: [fileURLToPath(new URL("../", import.meta.url))] } },
  // プロジェクトルートの.envを取得
  envDir: "../../",
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
