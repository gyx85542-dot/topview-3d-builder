import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { normalizeLocale, translate } from "./i18n.js";
let currentLocale = 'en';
const t = (key, values = {}) => translate(currentLocale, key, values);
const trackedNodes = new Set();
const iconUrl = new URL('./icon.png', import.meta.url).href;
const titleIcon = new Image();
titleIcon.src = iconUrl;
titleIcon.onload = () => app.canvas?.setDirty(true, true);
function fitCard(node) {
  if (!node._topviewBox || node._topviewSizing) return;
  node._topviewSizing = true;
  const width = node.size[0];
  node._topviewHeight = node._topviewAspect
    ? width / node._topviewAspect
    : 176;
  node.setSize([width, node._topviewHeight + 26]);
  node._topviewSizing = false;
  app.canvas?.setDirty(true, true);
}
const videoOverrides = new WeakMap();
function restoreVideoLayout(node) {
  const saved = videoOverrides.get(node);
  if (!saved) return;
  if (saved.widget.computeLayoutSize === saved.override) {
    if (saved.own) saved.widget.computeLayoutSize = saved.original;
    else delete saved.widget.computeLayoutSize;
  }
  saved.video.removeEventListener('pointerdown', saved.drag, true);
  saved.video.style.cssText = saved.style;
  saved.video.draggable = saved.draggable;
  videoOverrides.delete(node);
}
// Restrict native media adjustments to files produced by this extension.
function fitExportedVideo(node) {
  const file = node.widgets?.find((w) => w.name === 'file')?.value;
  if (typeof file !== 'string' || !file.startsWith('topview3d/exports/')) { restoreVideoLayout(node); return; }
  const widget = node.widgets?.find((w) => w.name === 'video-preview');
  const video = node.videoContainer?.querySelector('video');
  if (!widget || !video?.videoWidth || !video.videoHeight) return;
  const margin = widget.margin ?? 10;
  const height = (node.size[0] - margin * 2) * video.videoHeight / video.videoWidth + margin * 2;
  let saved = videoOverrides.get(node);
  if (saved && (saved.widget !== widget || saved.video !== video)) { restoreVideoLayout(node); saved = null; }
  if (!saved) {
    const drag = (event) => {
      const currentFile = node.widgets?.find((w) => w.name === 'file')?.value;
      if (!currentFile?.startsWith('topview3d/exports/')) { restoreVideoLayout(node); return; }
      const rect = video.getBoundingClientRect();
      const controlsHeight = 48 * (rect.width / Math.max(1, video.clientWidth));
      if (event.button !== 0 || event.clientY >= rect.bottom - controlsHeight || document.fullscreenElement) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      app.canvas?.canvas.dispatchEvent(new PointerEvent(event.type, event));
    };
    saved = {widget, video, original:widget.computeLayoutSize, own:Object.hasOwn(widget, 'computeLayoutSize'), style:video.style.cssText, draggable:video.draggable, drag};
    saved.override = () => {
      const h = (node.size[0] - margin * 2) * video.videoHeight / video.videoWidth + margin * 2;
      return {minHeight:h, maxHeight:h, minWidth:0};
    };
    videoOverrides.set(node, saved);
    widget.computeLayoutSize = saved.override;
    Object.assign(video.style, {width:'100%',height:'100%',objectFit:'contain',userSelect:'none'});
    video.draggable = false;
    video.addEventListener('pointerdown', drag, true);
  }
  const target = widget.y + height + 4;
  if (Math.abs(node.size[1] - target) > 0.5) node.setSize([node.size[0], target]);
}

function syncLocale() {
  const next = normalizeLocale(app.extensionManager?.setting?.get('Comfy.Locale') || app.ui?.settings?.getSettingValue('Comfy.Locale') || document.documentElement.lang || navigator.language);
  if (next === currentLocale) return;
  currentLocale = next;
  for (const node of trackedNodes) {
    if (node._topviewOpen) node._topviewOpen.name = t('open');
    if (node._topviewImage) updatePreview(node);
  }
  if (activeEditor) {
    activeEditor.title = t('editor');
    activeEditor.contentWindow?.postMessage({source:'topview3d-host',type:'locale',locale:currentLocale},location.origin);
  }
  app.canvas?.setDirty(true,true);
}
let activeEditor = null;
const url = (path) => api.apiURL(path);

function stateOf(node) {
  node.properties ||= {};
  return {
    get value() { return node.properties.topview_scene_state || ""; },
    set value(raw) { node.properties.topview_scene_state = raw; },
  };
}

function migrateNode(node, info) {
  if (!stateOf(node).value) {
    const legacy = node.widgets?.find((w) => w.name === "scene_state")?.value
      || info?.widgets_values?.find((value) => typeof value === "string" && value.startsWith('{'));
    if (legacy) stateOf(node).value = legacy;
  }
  const graph = node.graph;
  const removedLinks = new Set([
    ...(node.inputs || []).map((input) => input.link),
    ...(node.outputs || []).flatMap((output) => output.links || []),
  ].filter((id) => id != null));
  // Other nodes may configure after this one and restore obsolete link IDs.
  // Clear their references once the synchronous graph restoration completes.
  if (graph && removedLinks.size) queueMicrotask(() => {
    if (node.graph !== graph) return;
    for (const other of graph._nodes) {
      for (const input of other.inputs || []) {
        if (removedLinks.has(input.link)) input.link = null;
      }
      for (const output of other.outputs || []) {
        if (output.links) output.links = output.links.filter((id) => !removedLinks.has(id));
      }
    }
  });
  while (node.inputs?.length) node.removeInput(node.inputs.length - 1);
  while (node.outputs?.length) node.removeOutput(node.outputs.length - 1);
  node.widgets = node.widgets?.filter((w) => w.name !== "scene_state") || [];
}

function updatePreview(node) {
  try {
    const state = JSON.parse(stateOf(node)?.value || "{}");
    const source = state.render_id ? url(`/topview3d/render/${state.render_id}`) : iconUrl;
    if (node._topviewImage.getAttribute('src') !== source) node._topviewImage.src = source;
    node._topviewAspect = state.render_id ? (state.width || 1280) / (state.height || 720) : null;
    node._topviewBox.dataset.preview = state.render_id ? 'true' : 'false';
    Object.assign(node._topviewImage.style, state.render_id
      ? {width:'100%',height:'100%',borderRadius:'4px'}
      : {width:'96px',height:'96px',borderRadius:'12px'});
    node._topviewStatus.style.display = state.render_id ? 'none' : 'block';
    fitCard(node);
    node._topviewStatus.textContent = state.render_id ? '' : t('pending');
  } catch {
    node._topviewStatus.textContent = t('invalidState');
  }
}

function openEditor(node) {
  syncLocale();
  if (activeEditor) { activeEditor.focus(); return; }
  const initialState = stateOf(node).value;
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {position:"fixed", inset:"0", zIndex:"100000", background:"#0009", display:"grid", placeItems:"center"});
  const iframe = document.createElement("iframe");
  iframe.title = t('editor');
  iframe.dataset.topviewEditor = 'true';
  iframe.src = url("/topview3d/editor/index.html");
  Object.assign(iframe.style, {width:"90vw",height:"90vh",border:"1px solid #444",borderRadius:"12px",boxShadow:"0 24px 80px #0009",background:"#16171b"});
  overlay.append(iframe);
  const close = () => {
    window.removeEventListener("message", receive);
    overlay.remove(); activeEditor = null;
    delete node._topviewClose;
  };
  const receive = (event) => {
    if (event.origin !== location.origin || event.source !== iframe.contentWindow) return;
    const message = event.data;
    if (message?.source !== "topview3d-editor") return;
    if (message.type === "ready") {
      iframe.contentWindow.postMessage({source:"topview3d-host", type:"init", locale:currentLocale, state:stateOf(node).value}, location.origin);
    } else if (message.type === "state" && typeof message.state === "string") {
      stateOf(node).value = message.state;
      updatePreview(node);
      app.graph?.change?.();
      app.canvas?.setDirty(true, true);
    } else if (message.type === "media") {
      let created;
      try {
        const kind = message.kind === "video" ? "LoadVideo" : "LoadImage";
        created = globalThis.LiteGraph.createNode(kind);
        if (!created) throw new Error(t('missingNode',{detail:kind}));
        const widget = created.widgets?.find((w) => w.name === (kind === "LoadVideo" ? "file" : "image"));
        if (!widget) throw new Error(t('missingInput',{detail:kind}));
        const file = message.file;
        if (file?.type !== "input" || typeof file.name !== "string" || typeof file.subfolder !== "string") throw new Error(t('invalidMedia'));
        const filename = file.subfolder ? `${file.subfolder}/${file.name}` : file.name;
        const offset = node._topviewExportCount || 0;
        created.pos = [node.pos[0] + node.size[0] + 70, node.pos[1] + offset * 100];
        created.title = `Topview 3D Builder · ${t(kind === 'LoadVideo' ? 'video' : 'image')}`;
        app.graph.add(created);
        if (Array.isArray(widget.options?.values) && !widget.options.values.includes(filename)) widget.options.values.push(filename);
        widget.value = filename;
        widget.callback?.(filename);
        node._topviewExportCount = offset + 1;
        app.graph.change?.(); app.canvas?.setDirty(true, true);
        iframe.contentWindow.postMessage({source:"topview3d-host",requestId:message.requestId},location.origin);
      } catch (error) {
        if (created?.graph) app.graph.remove(created);
        iframe.contentWindow.postMessage({source:"topview3d-host",requestId:message.requestId,error:String(error)},location.origin);
      }
    } else if (message.type === "discard") {
      stateOf(node).value = initialState;
      updatePreview(node);
      app.graph?.change?.();
      close();
    } else if (message.type === "close") close();
  };
  window.addEventListener("message", receive);
  node._topviewClose = close;
  document.body.append(overlay);
  activeEditor = iframe;
}

app.registerExtension({
  name: "Topview.3D.Builder",
  async addCustomNodeDefs(defs) {
    const def = defs.Topview3DScene;
    if (def) { def.display_name = 'Topview 3D Builder'; def.category = 'Topview'; }
  },
  setup() {
    const style = document.createElement('style');
    style.textContent = '.dom-widget:has([data-topview-passive]), [data-topview-passive], [data-topview-passive] * { pointer-events: none !important; user-select: none !important; -webkit-user-drag: none; }';
    style.textContent += `.litemenu-entry.topview-category-icon::before { content: ""; display: inline-block; width: 16px; height: 16px; margin-right: 6px; vertical-align: -3px; border-radius: 4px; background: url("${iconUrl}") center / contain no-repeat; pointer-events: none; }`;
    style.textContent += `
      .topview-library-label::before {
        content:""; display:inline-block; width:16px; height:16px;
        margin-inline-end:6px; vertical-align:-3px; border-radius:4px;
        background:url("${iconUrl}") center / contain no-repeat;
        pointer-events:none; user-select:none;
      }
    `;
    document.head.append(style);
    // Decorate only our category, keeping the original menu entry and callback.
    const decorate = (element) => {
      if (!(element instanceof Element)) return;
      const entries = element.matches('.litemenu-entry') ? [element] : element.querySelectorAll('.litemenu-entry');
      for (const entry of entries) {
        if (entry.value?.value === 'Topview/') entry.classList.add('topview-category-icon');
      }
    };
    const decorateLibrary = (element) => {
      if (!(element instanceof Element)) return;
      const selector = '[role="treeitem"]';
      const rows = new Set(element.querySelectorAll(selector));
      const row = element.closest(selector);
      if (row) rows.add(row);
      for (const item of rows) {
        // Decorate the label only. Native folder icons and expand controls
        // remain untouched; unknown label structures safely keep the native UI.
        const label = item.querySelector(':scope > span, :scope > .p-tree-node-content [data-folder-name], :scope > .p-tree-node-content [data-node-name]');
        for (const old of item.querySelectorAll('.topview-library-label')) {
          if (old.closest('[role="treeitem"]') === item && old !== label) old.classList.remove('topview-library-label');
        }
        const name = label?.textContent.trim();
        label?.classList.toggle('topview-library-label', name === 'Topview' || name === 'Topview 3D Builder');
      }
    };
    // Observe only mounted node libraries and context menus. A cheap root scan
    // discovers replacements without subscribing to canvas/editor mutations.
    const roots = new Map();
    const discover = () => {
      for (const [root, observer] of roots) {
        if (!root.isConnected) { observer.disconnect(); roots.delete(root); }
      }
      for (const root of document.querySelectorAll('[role="tree"], .p-tree, .litecontextmenu')) {
        if (roots.has(root)) continue;
        let queued = false;
        const refresh = () => { decorate(root); decorateLibrary(root); };
        const observer = new MutationObserver(() => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => { queued = false; if (root.isConnected) refresh(); });
        });
        observer.observe(root, {childList:true, characterData:true, subtree:true});
        roots.set(root, observer);
        refresh();
      }
    };
    discover();
    setInterval(discover, 500);
    syncLocale(); setInterval(syncLocale, 500);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === 'Topview3DScene' || nodeData.name === 'LoadVideo') {
      const hitTest = nodeType.prototype.getWidgetOnPos;
      nodeType.prototype.getWidgetOnPos = function () {
        const widget = hitTest?.apply(this, arguments);
        if (widget?.name === 'topview_preview') return undefined;
        const file = this.widgets?.find((w) => w.name === 'file')?.value;
        if (widget?.name === 'video-preview' && typeof file === 'string' && file.startsWith('topview3d/exports/')) return undefined;
        return widget;
      };
    }
    if (nodeData.name === 'LoadVideo') {
      const removed = nodeType.prototype.onRemoved;
      nodeType.prototype.onRemoved = function () { restoreVideoLayout(this); return removed?.apply(this, arguments); };
      const draw = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function () {
        draw?.apply(this, arguments);
        fitExportedVideo(this);
      };
    }
    if (nodeData.name !== "Topview3DScene") return;
    nodeData.display_name = 'Topview 3D Builder';
    nodeData.category = 'Topview';
    nodeType.category = 'Topview';
    nodeType.title = 'Topview 3D Builder';
    const drawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      drawForeground?.apply(this, arguments);
      if (titleIcon.complete && titleIcon.naturalWidth) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(8, -25, 20, 20, 4);
        ctx.clip();
        ctx.drawImage(titleIcon, 8, -25, 20, 20);
        ctx.restore();
      }
    };
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      this.title = "Topview 3D Builder";
      migrateNode(this);
      syncLocale();
      trackedNodes.add(this);
      this._topviewOpen = this.addWidget("button", t('open'), null, () => openEditor(this), {serialize:false});
      const box = this._topviewBox = document.createElement("div");
      box.dataset.topviewPassive = 'true';
      Object.assign(box.style, {padding:"0",color:"#bbb",height:"100%",boxSizing:"border-box",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",overflow:"hidden",pointerEvents:"none",userSelect:"none"});
      this._topviewImage = document.createElement("img");
      Object.assign(this._topviewImage.style, {display:"block",objectFit:"contain",flexShrink:"0"});
      this._topviewImage.alt = 'Topview 3D Builder';
      this._topviewImage.draggable = false;
      this._topviewImage.onload = () => {
        if (this._topviewAspect) this._topviewAspect = this._topviewImage.naturalWidth / this._topviewImage.naturalHeight;
        fitCard(this);
      };
      this._topviewStatus = document.createElement("div");
      this._topviewStatus.style.cssText = "font:12px sans-serif;text-align:center;padding:6px;line-height:1.6";
      box.append(this._topviewImage, this._topviewStatus);
      this.addDOMWidget("topview_preview", "preview", box, {serialize:false, hideOnZoom:false, margin:0, getMinHeight:()=>this._topviewHeight || 176, getMaxHeight:()=>this._topviewHeight || 176, afterResize:()=>fitCard(this)});
      this.setSize([340, 220]);
      updatePreview(this);
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      migrateNode(this, arguments[0]);
      if (this.title === "Topview 3D Scene") this.title = "Topview 3D Builder";
      if (this._topviewImage) updatePreview(this);
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      trackedNodes.delete(this);
      this._topviewClose?.();
      return removed?.apply(this, arguments);
    };
  },
});
