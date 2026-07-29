import path from 'path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { sogniBackendPlugin } from './server/sogniBackend';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const engineMode = process.env.CINEGEN_ENGINE_URL || env.CINEGEN_ENGINE_URL || '';
    const sogniProxy = {
      target: 'https://api.sogni.ai',
      changeOrigin: true,
      secure: true,
      headers: {
        Authorization: `Bearer ${env.SOGNI_API_KEY || ''}`,
      },
      rewrite: (requestPath: string) => requestPath.replace(/^\/api\/sogni/, ''),
    };

    return {
      server: {
        port: 3002,
        host: '0.0.0.0',
        proxy: {
          // Proxy /api/sogni/* → https://api.sogni.ai/*
          // Bypasses browser CORS — requests go through Vite's Node.js server
          '/api/sogni': sogniProxy,
        },
      },
      preview: {
        host: '0.0.0.0',
        proxy: {
          '/api/sogni': sogniProxy,
        },
      },
      plugins: [
        react(),
        sogniBackendPlugin(
          env.SOGNI_API_KEY || '',
          env.GEMINI_API_KEY || '',
          // Sogni direta é o padrão. Um motor intermediário só é usado
          // quando CINEGEN_ENGINE_URL for configurado explicitamente.
          engineMode === 'direct' ? '' : engineMode,
        ),
      ],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(projectRoot),
        }
      }
    };
});
