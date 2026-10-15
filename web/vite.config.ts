import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// I dati prodotti dalla pipeline restano in data/processed/ (unica fonte):
// in sviluppo vengono serviti su /data/, in build copiati in dist/data/.
const DATA_DIR = fileURLToPath(new URL('../data/processed', import.meta.url))
const DATA_FILE = /^[\w.-]+\.(geo)?json$/

function processedData(): Plugin {
  return {
    name: 'processed-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '')
        if (!DATA_FILE.test(name)) return next()
        try {
          const body = readFileSync(join(DATA_DIR, name))
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(body)
        } catch {
          next()
        }
      })
    },
    generateBundle() {
      for (const name of readdirSync(DATA_DIR).filter((n) => DATA_FILE.test(n))) {
        this.emitFile({ type: 'asset', fileName: `data/${name}`, source: readFileSync(join(DATA_DIR, name)) })
      }
    },
  }
}

export default defineConfig({
  // Percorsi relativi: la stessa build funziona su GitHub Pages (/nome-repo/) e su un dominio proprio.
  base: './',
  plugins: [processedData()],
  server: { host: true },
  // MapLibre da solo pesa ~1 MB (290 KB compresso): è atteso.
  build: { chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
})
