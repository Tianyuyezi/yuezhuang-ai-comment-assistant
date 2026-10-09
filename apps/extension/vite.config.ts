import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import manifest from './public/manifest.json';

export default defineConfig({
  define: { __YUEZHUANG_CONTENT_VERSION__: JSON.stringify(manifest.version) },
  plugins: [react(), {
    name: 'assert-standalone-content-script',
    generateBundle(_options, bundle) {
      const content = bundle['content.js'];
      if (content?.type === 'chunk' && content.imports.length) this.error('MV3 content.js must not import another module');
      if (content?.type === 'chunk') content.code = `(function(){\n${content.code}\n})();`;
    }
  }],
  build: {
    outDir: 'dist', emptyOutDir: true,
    rollupOptions: {
      input: { sidepanel: resolve(__dirname, 'sidepanel.html'), options: resolve(__dirname, 'options.html'), background: resolve(__dirname, 'src/background.ts'), content: resolve(__dirname, 'src/content.ts') },
      output: { entryFileNames: (chunk) => `${chunk.name}.js`, chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' }
    }
  }
});
