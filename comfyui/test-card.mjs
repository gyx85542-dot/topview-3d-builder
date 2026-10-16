import {createRequire} from 'node:module'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const require=createRequire(process.cwd()+'/editor/apps/studio/package.json')
const {chromium}=require('playwright')
const browser=await chromium.launch()
try {
 const page=await browser.newPage({viewport:{width:1400,height:1000}})
 const errors=[];page.on('pageerror',e=>errors.push(String(e)))
 await page.goto('http://127.0.0.1:8189')
 await page.waitForFunction(()=>window.comfyAPI?.app?.app?.graph && globalThis.LiteGraph?.registered_node_types?.Topview3DScene)
 await page.waitForTimeout(3000)
 await page.evaluate(()=>{const app=window.comfyAPI.app.app;app.graph.clear();const n=LiteGraph.createNode('Topview3DScene');app.graph.add(n);n.pos=[180,180];window.n=n;app.canvas.ds.scale=1;app.canvas.ds.offset=[0,0]})
 await page.waitForTimeout(500)
 assert.equal(await page.evaluate(()=>n._topviewStatus.textContent),'Click [Open 3D Builder] to build your 3D scene. Supports export as image or video.')
 assert.equal(await page.evaluate(()=>LiteGraph.registered_node_types.Topview3DScene.title),'Topview 3D Builder')
 assert.equal(await page.evaluate(()=>n._topviewImage.naturalWidth),1024)
 await page.screenshot({path:'comfyui/test-results/icon-card.png'})
 const raw=await fs.readFile('comfyui/test-results/scene.json','utf8')
 for(const [width,height] of [[1280,720],[720,720],[720,1280]]) {
  await page.evaluate(async({raw,width,height})=>{
   const state=JSON.parse(raw);state.width=width;state.height=height
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
   const ctx=canvas.getContext('2d');ctx.fillStyle='#8020ff';ctx.fillRect(0,0,width,height)
   const blob=await new Promise(resolve=>canvas.toBlob(resolve))
   const form=new FormData();form.append('state',JSON.stringify(state));form.append('image',blob,'preview.png')
   const res=await fetch('/topview3d/render',{method:'POST',body:form});state.render_id=(await res.json()).render_id
   n.properties.topview_scene_state=JSON.stringify(state);n.onConfigure({})
  },{raw,width,height})
  await page.waitForFunction(width=>n._topviewImage.naturalWidth===width && n._topviewImage.complete,width)
  await page.waitForTimeout(300)
  const size=await page.evaluate(()=>({node:[...n.size],box:n._topviewBox.getBoundingClientRect().toJSON(),img:n._topviewImage.getBoundingClientRect().toJSON(),y:n.widgets[1].y}))
  assert.ok(Math.abs(size.img.width/size.img.height-width/height)<0.01,JSON.stringify(size))
  assert.ok(Math.abs(size.node[1]-size.y-size.box.height)<1,JSON.stringify(size))
  await page.evaluate(()=>n.setSize([420,800]))
  await page.waitForTimeout(200)
  const resized=await page.evaluate(()=>({size:[...n.size],height:n._topviewBox.getBoundingClientRect().height,y:n.widgets[1].y}))
  assert.ok(Math.abs(resized.size[1]-resized.y-resized.height)<1,JSON.stringify(resized))
 }
 await page.evaluate(raw=>{n.properties.topview_scene_state=raw;n.setSize([340,300]);n.onConfigure({})},raw)
 await page.waitForTimeout(500)
 await page.screenshot({path:'comfyui/test-results/fitted-card.png'})
 assert.deepEqual(errors,[])
 console.log('Branding, exact copy, icon, landscape/square/portrait sizing and manual resize passed')
}finally{await browser.close()}
