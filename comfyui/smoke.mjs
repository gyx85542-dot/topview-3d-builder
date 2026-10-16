import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here,'../editor/apps/studio/package.json'))
const { chromium } = require('playwright')
const base = process.env.COMFY_URL || 'http://127.0.0.1:8189'
const output = path.join(here,'test-results')
await fs.mkdir(output,{recursive:true})
const browser = await chromium.launch({args:['--enable-webgl','--ignore-gpu-blocklist']})
const page = await browser.newPage({viewport:{width:1600,height:1000}})
const errors = []
const failedPluginRequests = []
page.on('response', (response) => { if (response.url().includes('/topview3d/') && response.status() >= 400) failedPluginRequests.push(response.url()) })
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => { if (message.type() === 'error') console.log('BROWSER:',message.text().slice(0,350)) })
try {
  await page.goto(base,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(() => {
    const app = window.comfyAPI?.app?.app
    return !!app?.canvas && Array.isArray(app?.graph?._nodes) && !!globalThis.LiteGraph?.registered_node_types?.Topview3DScene && !!document.querySelector('canvas')
  },null,{timeout:90000})
  console.log('Plugin registered')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2500)
  // Browser-only language override: never change the user's persisted ComfyUI settings.
  await page.evaluate(() => {
    const settings = window.comfyAPI.app.app.ui.settings
    const original = settings.getSettingValue.bind(settings)
    window.testLocale = 'zh'
    settings.getSettingValue = (id, ...args) => id === 'Comfy.Locale' ? window.testLocale : original(id,...args)
    const manager = window.comfyAPI.app.app.extensionManager?.setting
    if (manager) { const get = manager.get.bind(manager); manager.get = (id) => id === 'Comfy.Locale' ? window.testLocale : get(id) }
  })
  await page.waitForTimeout(600)
  await page.evaluate(async () => {
    const {app} = await import('/scripts/app.js')
    app.graph.clear()
    const node = globalThis.LiteGraph.createNode('Topview3DScene')
    node.pos = [100,100]; app.graph.add(node)
    window.testNode = node
    node._topviewOpen.callback()
  })
  const editor = page.frameLocator('iframe[data-topview-editor]')
  await editor.locator('.t3d-root[aria-busy="false"] canvas').first().waitFor({timeout:60000})
  assert.equal(await editor.locator('.t3d-leftrail-rail-btn', {hasText:/^(动作|Motions)$/}).count(),0)
  await editor.locator('.t3d-leftrail-rail-btn', {hasText:/^角色$/}).click()
  await editor.getByText(/^(男性|Man|Male)$/).click()
  await editor.locator('.t3d-inspector-tab', {hasText:/姿势/}).click()
  await editor.locator('.t3d-pose-tag', {hasText:/坐|sit/i}).first().click()
  await editor.locator('button.t3d-pose-atlas-cell:not(.is-skel)').first().click()
  await page.waitForFunction(() => {
    const raw = window.testNode.properties.topview_scene_state
    const nodes = JSON.parse(raw).document.content.nodes
    return nodes.filter((n) => n.type === 'character').length === 2 && /"posePresetId":"(?!stand)[^"]+"/.test(raw)
  })
  const bounds = await page.locator('iframe[data-topview-editor]').boundingBox()
  assert.equal(Math.round(bounds.width),1440)
  assert.equal(Math.round(bounds.height),900)
  assert.equal(await editor.locator('.host-toolbar').count(),0)
  assert.equal(await editor.locator('.t3d-topbar-right .host-save-exit').count(),1)
  assert.equal(await editor.locator('.host-toolbar input').count(),0)
  assert.equal(await editor.locator('.host-status').count(),0)
  await page.screenshot({path:path.join(output,'floating-editor.png')})
  await page.route('**/topview3d/render', route => route.fulfill({status:500,contentType:'application/json',body:'{"error":"Test save failure"}'}))
  await editor.getByRole('button',{name:'保存并退出',exact:true}).click()
  await editor.locator('.host-status').filter({hasText:'Test save failure'}).waitFor()
  assert.equal(await page.locator('iframe[data-topview-editor]').count(),1)
  await page.unroute('**/topview3d/render')
  await editor.getByRole('button',{name:'保存并退出',exact:true}).click()
  await page.locator('iframe[data-topview-editor]').waitFor({state:'detached',timeout:60000})
  const state = await page.evaluate(() => window.testNode.properties.topview_scene_state)
  const parsed = JSON.parse(state)
  assert.ok(parsed.render_id)
  await fs.writeFile(path.join(output,'scene.json'),state)
  const image = await fetch(`${base}/topview3d/render/${parsed.render_id}`)
  assert.equal(image.status,200)
  await fs.writeFile(path.join(output,'render.png'),Buffer.from(await image.arrayBuffer()))
  const card = await page.evaluate(() => ({inputs:window.testNode.inputs.length,outputs:window.testNode.outputs.length,status:window.testNode._topviewStatus.textContent}))
  assert.deepEqual(card,{inputs:0,outputs:0,status:''})
  await page.screenshot({path:path.join(output,'node.png')})
  console.log('90% floating editor, no ports, save failure/retry and Save and Exit passed')
  // Reload the serialized workflow, then reopen the editor to check persistence.
  await page.evaluate(async () => {
    const {app} = await import('/scripts/app.js')
    const workflow = app.graph.serialize()
    await app.loadGraphData(workflow)
    window.testNode = app.graph._nodes.find((n) => n.type === 'Topview3DScene')
    window.testNode._topviewOpen.callback()
  })
  await editor.locator('.t3d-root[aria-busy="false"] canvas').first().waitFor({timeout:60000})
  console.log('Workflow serialization and reopen passed')
  const restored = await page.evaluate(() => window.testNode.properties.topview_scene_state)
  assert.equal(JSON.parse(restored).document.content.nodes.filter((n) => n.type === 'character').length,2)
  assert.equal(await page.evaluate(() => window.testNode.title),'Topview 3D Builder')
  await editor.locator('.t3d-topbar-export-btn').click()
  await editor.locator('.t3d-export-modal').getByRole('button',{name:'取消',exact:true}).click()
  await editor.locator('.t3d-topbar-export-btn').click()
  const dialog = editor.locator('.t3d-export-modal')
  await dialog.getByRole('button',{name:'导出到 ComfyUI 画布',exact:true}).click()
  await page.locator('iframe[data-topview-editor]').waitFor({state:'detached',timeout:60000})
  assert.ok(await page.evaluate(() => JSON.parse(window.testNode.properties.topview_scene_state).render_id))
  await page.waitForFunction(() => window.comfyAPI.app.app.graph._nodes.some((n) => n.type === 'LoadImage'))
  await page.evaluate(() => window.testNode._topviewOpen.callback())
  await editor.locator('.t3d-root[aria-busy="false"] canvas').first().waitFor({timeout:60000})
  await editor.locator('.t3d-topbar-export-btn').click()
  await dialog.getByRole('tab',{name:'视频',exact:true}).click()
  assert.equal(await dialog.getByRole('tab',{name:'视频',exact:true}).getAttribute('aria-selected'),'true')
  const rangeInputs = dialog.locator('.t3d-export-field-values input')
  await rangeInputs.nth(1).fill('8')
  await rangeInputs.nth(1).press('Enter')
  await dialog.getByRole('button',{name:'分辨率',exact:true}).click()
  await editor.getByRole('option',{name:/720p/}).click()
  await dialog.getByRole('button',{name:'导出到 ComfyUI 画布',exact:true}).click()
  await page.waitForFunction(() => window.comfyAPI.app.app.graph._nodes.some((n) => n.type === 'LoadVideo'),null,{timeout:90000})
  await page.locator('iframe[data-topview-editor]').waitFor({state:'detached',timeout:60000})
  assert.ok(await page.evaluate(() => JSON.parse(window.testNode.properties.topview_scene_state).render_id))
  await page.screenshot({path:path.join(output,'canvas-export.png')})
  const files = await page.evaluate(() => {
    const nodes = window.comfyAPI.app.app.graph._nodes
    return {
      image:nodes.find((n) => n.type === 'LoadImage').widgets.find((w) => w.name === 'image').value,
      video:nodes.find((n) => n.type === 'LoadVideo').widgets.find((w) => w.name === 'file').value,
    }
  })
  const mediaPrompt = {
    '1':{class_type:'LoadImage',inputs:{image:files.image}},
    '2':{class_type:'PreviewImage',inputs:{images:['1',0]}},
    '3':{class_type:'LoadVideo',inputs:{file:files.video}},
    '4':{class_type:'GetVideoComponents',inputs:{video:['3',0]}},
    '5':{class_type:'PreviewImage',inputs:{images:['4',0]}},
  }
  const mediaResponse = await fetch(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:mediaPrompt})})
  const mediaQueued = await mediaResponse.json()
  assert.equal(mediaResponse.status,200,JSON.stringify(mediaQueued))
  let mediaHistory
  for(let i=0;i<60;i++) {
    mediaHistory = await (await fetch(`${base}/history/${mediaQueued.prompt_id}`)).json()
    if(mediaHistory[mediaQueued.prompt_id]) break
    await new Promise((resolve) => setTimeout(resolve,500))
  }
  assert.equal(mediaHistory[mediaQueued.prompt_id]?.status?.status_str,'success',JSON.stringify(mediaHistory))
  console.log('Image and video export to canvas and downstream execution passed')
  await page.evaluate(() => window.testNode._topviewOpen.callback())
  await editor.locator('.t3d-root[aria-busy="false"] canvas').first().waitFor({timeout:60000})
  const stableState = await page.evaluate(() => window.testNode.properties.topview_scene_state)
  const {messages} = await import('./ComfyUI-Topview3D/web/i18n.js')
  const languageChecks = Object.entries(messages).map(([locale,row]) => [locale,locale,row.close])
  const localizedEditor = page.frameLocator('iframe[data-topview-editor]')
  await page.setViewportSize({width:800,height:800})
  for(const [setting,locale,label] of languageChecks) {
    await page.evaluate((value)=>{window.testLocale=value},setting)
    await localizedEditor.locator('.t3d-topbar-right').getByRole('button',{name:label,exact:true}).waitFor()
    await page.waitForFunction(value => document.querySelector('iframe[data-topview-editor]')?.contentDocument?.querySelector('.t3d-root')?.getAttribute('lang') === value,locale)
    assert.equal(await localizedEditor.locator('.t3d-root').getAttribute('lang'),locale)
    const layout = await localizedEditor.locator('.t3d-topbar').evaluate(el => { const center=el.querySelector('.t3d-topbar-center').getBoundingClientRect(), button=el.querySelector('.host-save-exit').getBoundingClientRect(); return {height:el.clientHeight, overflow:el.scrollWidth-el.clientWidth, aligned:Math.abs(center.y+center.height/2-button.y-button.height/2)} })
    assert.ok(layout.height <= 48 && layout.overflow <= 1 && layout.aligned < 3,JSON.stringify({locale,layout}))
    assert.equal(await page.evaluate(() => window.testNode.properties.topview_scene_state),stableState)
    if(locale === 'ar') {
      assert.equal(await localizedEditor.locator('.host-save-exit').getAttribute('dir'),'rtl')
      await page.screenshot({path:path.join(output,'locale-ar.png')})
    }
    if(locale === 'en') {
      await localizedEditor.locator('.t3d-topbar-export-btn').click()
      await localizedEditor.getByRole('button',{name:'Export to ComfyUI canvas',exact:true}).waitFor()
      await page.screenshot({path:path.join(output,'locale-en.png')})
      await localizedEditor.getByRole('button',{name:'Cancel',exact:true}).click()
    }
  }
  console.log('All 15 live locale switches passed; scene state unchanged')
  await localizedEditor.locator('.host-save-exit').click()
  await page.locator('iframe[data-topview-editor]').waitFor({state:'detached',timeout:60000})
  await page.evaluate(async () => {
    const app = window.comfyAPI.app.app
    const preview = globalThis.LiteGraph.createNode('PreviewImage')
    app.graph.add(preview)
    window.testNode.addOutput('image','IMAGE')
    window.testNode.connect(0,preview,0)
    const old = structuredClone(app.graph.serialize())
    const info = old.nodes.find(n => n.type === 'Topview3DScene')
    info.widgets_values = [info.properties.topview_scene_state]
    delete info.properties.topview_scene_state
    info.inputs = [{name:'scene_state',type:'STRING',link:null}]
    info.outputs.push({name:'scene_json',type:'STRING',links:[]})
    await app.loadGraphData(old)
    window.testNode = app.graph._nodes.find(n => n.type === 'Topview3DScene')
  })
  assert.equal(await page.evaluate(() => JSON.parse(window.testNode.properties.topview_scene_state).version),1)
  assert.equal(await page.evaluate(() => window.testNode.inputs.length + window.testNode.outputs.length),0)
  assert.equal(await page.evaluate(() => window.comfyAPI.app.app.graph._nodes.find(n => n.type === 'PreviewImage').inputs[0].link),null)
  assert.equal(await page.evaluate(() => window.comfyAPI.app.app.graph.serialize().links.length),0)
  console.log('Legacy scene and connected output migration passed')
  assert.deepEqual(errors,[])
  assert.equal(failedPluginRequests.length,1, 'Only the injected save failure is expected')
  console.log('SMOKE PASS')
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{})
  console.error(await page.locator('body').innerText().catch(()=>''))
  for(const frame of page.frames().slice(1)) console.error('FRAME:',await frame.locator('body').innerText().catch(()=>''))
  throw error
} finally {
  await browser.close()
}
