/// <reference types="vite/client" />
interface ImportMetaEnv {
    // その他の環境変数...
    readonly VITE_IP_ADDRESS: string
  }
  
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }