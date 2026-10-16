import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DirectorStudio, createInitialDraft, CAMERA_PRESETS, setDefaultDracoDecoderPath, type DirectorApi, type DirectorDocument, type HostAdapter, type AssetQuery, type PoseBonesPayload } from '@topview/3d-builder'
import '@topview/3d-builder/styles.css'
import './style.css'
import { normalizeLocale, translate } from '../ComfyUI-Topview3D/web/i18n.js'
let currentLocale = 'en'
const t = (key: string, values: Record<string, string | number> = {}) => translate(currentLocale, key, values)

const base = new URL('../', location.href)
const endpoint = (path: string) => new URL(path, base).href
setDefaultDracoDecoderPath(endpoint('editor/draco/'))
const send = (type: string, extra: object = {}) => parent.postMessage({ source: 'topview3d-editor', type, ...extra }, location.origin)

type SceneState = {
  version: 1
  document: DirectorDocument
  fcurves: unknown
  width: number
  height: number
  frame: number
  cameraId: string
  userKeysEnabled: boolean
  chainCameraMotion: boolean
  render_id: string
}
type Asset = { id: string; kind: string; name: string; file?: string; key?: string; cover?: string; category?: string; tags?: string[]; rig?: string }
let catalog: Asset[] = []
let state: SceneState
let director: DirectorApi | null = null
let documentId = 0
let busy = false
let finishMediaExport: (() => Promise<void>) | null = null

async function json(url: string) {
  const result = await fetch(url)
  if (!result.ok) throw new Error(t('loadFailed', {detail:`${result.status}: ${url}`}))
  return result.json()
}
const assetUrl = (file: string) => endpoint(`assets/${file.split('/').map(encodeURIComponent).join('/')}`)
function resolveAsset(key: string): string {
  const item = catalog.find((a) => a.key === key || a.file === key)
  if (item?.file) return assetUrl(item.file)
  const url = new URL(key, location.origin)
  if (url.origin === location.origin && url.pathname.startsWith(new URL(endpoint('assets/')).pathname)) return url.href
  throw new Error(t('missingAsset', {detail:key}))
}
function publish() { send('state', { state: JSON.stringify(state) }) }
function updateDocument(doc: DirectorDocument, fcurves: unknown) {
  const changed = JSON.stringify(state.document) !== JSON.stringify(doc) || JSON.stringify(state.fcurves) !== JSON.stringify(fcurves)
  state.document = structuredClone(doc)
  state.fcurves = structuredClone(fcurves ?? null)
  if (changed) state.render_id = ''
  publish()
}
const adapter: HostAdapter<DirectorDocument> = {
  displayName: 'Topview 3D Builder',
  get exportActionLabel() { return t('send') },
  get exportSuccessMessage() { return t('sent') },
  loadDocument: async () => structuredClone(state.document),
  loadFCurves: async () => structuredClone(state.fcurves),
  saveDocument: async (_id, doc) => updateDocument(doc, state.fcurves),
  saveDocumentState: async (_id, doc, fcurves) => updateDocument(doc, fcurves),
  onDocumentChange: (_id, doc, fcurves) => updateDocument(doc, fcurves),
  resolveAssetUrl: resolveAsset,
  resolveMediaUrl: (ref) => resolveAsset(ref.sourceUrl || (ref.kind === 'character' ? '' : ref.sourcePath) || ''),
  async searchAssets(query: AssetQuery) {
    const tokens = (query.keyword || '').toLowerCase().split(/\s+/).filter(Boolean)
    const hits = catalog.filter((a) => a.kind === query.kind && a.file &&
      (!query.category || a.category === query.category) &&
      (query.tags || []).every((tag) => a.tags?.includes(tag)) &&
      tokens.every((token) => `${a.name} ${a.id} ${a.category || ''} ${(a.tags || []).join(' ')}`.toLowerCase().includes(token)))
    const start = (query.pageNo - 1) * query.pageSize
    return {
      total: hits.length, pageNo: query.pageNo, pageSize: query.pageSize,
      items: hits.slice(start, start + query.pageSize).map((a) => ({
        id: a.kind === 'pose' ? a.id.replace(/^a3d_pose_/, '') : a.id,
        name: a.name, file: a.key || a.file!, category: a.category, tag: a.category, tags: a.tags,
        cover: a.cover ? assetUrl(a.cover) : '', coverUrl: a.cover ? assetUrl(a.cover) : undefined,
        modelUrl: assetUrl(a.file!), rig: a.rig?.toLowerCase() === 'ual1' ? 'ual1' as const : 'mixamorig' as const,
      })),
    }
  },
  async listAssetFacets(kind) {
    const assets = catalog.filter((a) => a.kind === kind)
    const count = (items: string[]) => [...new Set(items)].map((value) => ({value, count:items.filter((v) => v === value).length}))
    return { categories: count(assets.flatMap((a) => a.category ? [a.category] : [])), tags: count(assets.flatMap((a) => a.tags || [])) }
  },
  async loadPoseAsset(url): Promise<PoseBonesPayload | null> {
    const pose = await json(resolveAsset(url))
    return { hips: pose.hips, bones: pose.bones, poseId: pose.pose_id }
  },
  async loadPoseById(id) {
    const item = catalog.find((a) => a.id === id || a.id === `a3d_pose_${id}`)
    return item?.file ? adapter.loadPoseAsset!(assetUrl(item.file)) : null
  },
  async onExport(blob, meta) {
    if (meta.mimeType.startsWith('image/') || meta.mimeType.startsWith('video/')) {
      const form = new FormData()
      form.append('image', blob, `topview-${crypto.randomUUID()}-${meta.filename}`)
      form.append('type', 'input')
      form.append('subfolder', 'topview3d/exports')
      const response = await fetch(new URL('../upload/image', base), {method:'POST',body:form})
      if (!response.ok) throw new Error(t('uploadFailed', {detail:`HTTP ${response.status}`}))
      const file = await response.json()
      const requestId = crypto.randomUUID()
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { window.removeEventListener('message', receive); reject(new Error(t('timeout'))) }, 15000)
        const receive = (event: MessageEvent) => {
          if (event.origin !== location.origin || event.source !== parent || event.data?.source !== 'topview3d-host' || event.data.requestId !== requestId) return
          clearTimeout(timer); window.removeEventListener('message', receive)
          if (event.data.error) reject(new Error(event.data.error))
          else resolve()
        }
        window.addEventListener('message', receive)
        send('media', {requestId, file, kind:meta.mimeType.startsWith('video/') ? 'video' : 'image'})
      })
      if (!finishMediaExport) throw new Error(t('notReady'))
      await finishMediaExport()
      return
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = meta.filename; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}

async function restore(raw: string) {
  let next: SceneState
  if (raw) {
    const parsed = JSON.parse(raw)
    if (parsed.version !== 1 || parsed.document?.type !== 'biz/scene3d-director-document' || !Array.isArray(parsed.document?.content?.nodes)) throw new Error(t('invalidScene'))
    next = parsed
  } else {
    const doc = await createInitialDraft(adapter, { name:'ComfyUI Scene', fps:24, totalFrames:120, camera:CAMERA_PRESETS[0] })
    next = { version:1, document:doc, fcurves:null, width:1280, height:720, frame:0, cameraId:doc.content.activeShotCameraNodeId || '', userKeysEnabled:true, chainCameraMotion:false, render_id:'' }
  }
  if (!Number.isInteger(next.width) || !Number.isInteger(next.height) || next.width < 64 || next.height < 64 || next.width > 4096 || next.height > 4096 || !Number.isFinite(next.frame)) throw new Error(t('invalidSize'))
  state = next
  documentId += 1
  director = null
}

function App() {
  const [loaded, setLoaded] = useState(false)
  const [locale, setLocale] = useState(currentLocale)
  const [status, setStatusValue] = useState<{key:string; values:Record<string,string|number>}>({key:'loading', values:{}})
  const setStatus = (key:string, values:Record<string,string|number> = {}) => setStatusValue({key,values})
  const [working, setWorking] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let initialized = false
    const receive = async (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== parent || event.data?.source !== 'topview3d-host') return
      if (event.data.type === 'init' || event.data.type === 'locale') {
        currentLocale = normalizeLocale(event.data.locale)
        setLocale(currentLocale)
        document.documentElement.lang = currentLocale
      }
      if (event.data.type !== 'init' || initialized) return
      initialized = true
      try {
        catalog = (await json(endpoint('assets/manifest.json'))).assets
        await restore(event.data.state)
        publish()
        setLoaded(true); setStatus('help')
      } catch (error) { setStatus('error', {detail:String(error)}) }
    }
    window.addEventListener('message', receive)
    send('ready')
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => {
    if (!loaded) return
    setReady(false)
    const timer = window.setInterval(() => {
      if (!director?.session.ready) return
      const session = director.session
      if (state.cameraId && state.document.content.nodes.some((node) => node.id === state.cameraId && node.type === 'camera')) session.setActiveCamera(state.cameraId)
      if (session.userKeysEnabled !== state.userKeysEnabled) session.toggleUserKeys()
      if (session.chainCameraMotion !== state.chainCameraMotion) session.toggleChainCameraMotion()
      session.setFrame(state.frame)
      setReady(true)
      window.clearInterval(timer)
    }, 100)
    return () => window.clearInterval(timer)
  }, [loaded])

  useEffect(() => {
    finishMediaExport = () => run(async () => { await apply(); send('close') }, true)
    return () => { finishMediaExport = null }
  }, [])

  async function run(action: () => Promise<void>, rethrow = false) {
    if (busy) { if (rethrow) throw new Error(t('busy')); return }
    busy = true; setWorking(true)
    try { await action() } catch (error) {
      setStatus('error', {detail:error instanceof Error ? error.message : String(error)})
      if (rethrow) throw error
    }
    finally { busy = false; setWorking(false) }
  }
  async function save() {
    if (!director?.session.ready) throw new Error(t('notReady'))
    await director.session.flushPendingUserWrites()
    const error = await director.session.save({captureCover:false})
    if (error) throw new Error(error)
  }
  async function apply() {
    if (!director?.session.ready) throw new Error(t('notReady'))
    if (director.session.playing) director.session.togglePlay()
    director.stage.pause()
    await save()
    const session = director.session
    state.frame = Math.round(session.frame)
    state.cameraId = session.activeCameraId || state.document.content.activeShotCameraNodeId || ''
    state.userKeysEnabled = session.userKeysEnabled
    state.chainCameraMotion = session.chainCameraMotion
    state.render_id = ''
    publish()
    setStatus('rendering')
    const blob = await director.stage.previewFrame({ cameraId:state.cameraId, label:'ComfyUI', width:state.width, height:state.height, frame:state.frame, userKeys:session.userKeys, userKeysEnabled:state.userKeysEnabled, chainCameraMotion:state.chainCameraMotion })
    const form = new FormData()
    form.append('state', JSON.stringify(state)); form.append('image', blob, 'frame.png')
    const response = await fetch(endpoint('render'), {method:'POST', body:form})
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
    state.render_id = result.render_id
    publish(); setStatus('done', {width:state.width,height:state.height,frame:state.frame})
  }
  return <div className="host">
    {status.key === 'error' && <div className="host-status" role="alert">{t(status.key,status.values)} <button onClick={() => location.reload()}>{t('retry')}</button> <button onClick={() => send('discard')}>{t('discard')}</button></div>}
    <main>{loaded && <DirectorStudio topbarActions={<button dir={locale === 'ar' ? 'rtl' : 'ltr'} className="host-save-exit" disabled={!ready || working} onClick={() => void run(async () => { await apply(); send('close') })}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4l-8 8" /></svg><span>{t('close')}</span></button>} documentId={String(documentId)} adapter={adapter} locale={locale} onReady={(api) => { director = api }} autoSaveIntervalMs={3000} />}</main>
    {working && <div className="host-busy" role="alert">{t('busy')}</div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
