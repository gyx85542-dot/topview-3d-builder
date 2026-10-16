import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(here)
const builder = path.join(repo, 'editor/packages/builder')
const require = createRequire(await fs.realpath(path.join(repo, 'editor/node_modules/tsup/package.json')))
const { build } = require('esbuild')
const output = path.join(here, 'ComfyUI-Topview3D')
await fs.mkdir(path.join(output, 'editor'), {recursive:true})
await build({
  entryPoints:[path.join(here,'frontend/main.tsx')], outfile:path.join(output,'editor/main.js'),
  bundle:true, minify:true, format:'esm', platform:'browser', target:'es2022',
  nodePaths:[path.join(builder,'node_modules')],
  alias:{
    '@topview/3d-builder':path.join(builder,'dist/index.mjs'),
    '@topview/3d-builder/engine':path.join(builder,'dist/engine/index.mjs'),
    '@topview/3d-builder/styles.css':path.join(builder,'dist/styles.css'),
  },
  loader:{'.woff2':'file','.woff':'file'}, assetNames:'fonts/[name]-[hash]',
  define:{'process.env.NODE_ENV':'"production"'}, legalComments:'external',
})
await fs.copyFile(path.join(here,'frontend/index.html'),path.join(output,'editor/index.html'))
await fs.cp(path.join(builder,'dist/draco'),path.join(output,'editor/draco'),{recursive:true})
await fs.cp(path.join(repo,'builtin-assets'),path.join(output,'assets'),{recursive:true})
await fs.copyFile(path.join(repo,'LICENSE'),path.join(output,'LICENSE'))
await fs.copyFile(path.join(repo,'NOTICE'),path.join(output,'NOTICE'))
await fs.mkdir(path.join(output,'licenses'), {recursive:true})
for (const file of ['OFL.txt','OFL-instrument-sans.txt']) await fs.copyFile(path.join(builder,'src/styles/fonts',file),path.join(output,'licenses',file))
const notice = await fs.readFile(path.join(repo,'NOTICE'),'utf8')
await fs.writeFile(path.join(output,'NOTICE'), notice.replace(/Their licence texts are in[\s\S]*$/, 'Their licence texts are included in licenses/OFL.txt (Darker Grotesque) and\nlicenses/OFL-instrument-sans.txt (Instrument Sans).\n'))
console.log(`Built standalone plugin: ${output}`)
if (process.argv[2]) {
  const destination = path.resolve(process.argv[2], 'Topview-3D-Builder')
  const legacy = path.resolve(process.argv[2], 'ComfyUI-Topview3D')
  if (await fs.stat(legacy).then(() => true, () => false)) {
    const backup = `${legacy}-${Date.now()}.disabled`
    await fs.rename(legacy, backup)
    console.log(`Previous installation preserved: ${backup}`)
  }
  await fs.cp(output,destination,{recursive:true,filter:(source) => !source.split(path.sep).includes('__pycache__')})
  console.log(`Installed: ${destination}`)
}
