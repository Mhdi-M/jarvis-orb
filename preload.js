'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const subscribe = (channel) => (cb) => {
  const handler = (_event, ...args) => { try { cb(...args) } catch (e) { console.error(e) } }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('jarvis', {
  hover: (v) => ipcRenderer.send('ui:hover', !!v),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragTo: (sx, sy) => ipcRenderer.send('drag:to', { sx, sy }),
  dragEnd: () => ipcRenderer.send('drag:end'),
  hide: () => ipcRenderer.send('ui:hide'),
  show: () => ipcRenderer.send('ui:show'),
  activity: () => ipcRenderer.send('ui:activity'),
  recenter: () => ipcRenderer.send('ui:recenter'),
  fullscreen: (on) => ipcRenderer.send('ui:fullscreen', !!on),
  ask: (text, opts) => ipcRenderer.invoke('ask', text, opts),
  cancel: () => ipcRenderer.invoke('ask:cancel'),
  reset: () => ipcRenderer.invoke('reset'),
  pos: () => ipcRenderer.invoke('pos'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (patch) => ipcRenderer.invoke('theme:set', patch),
  },
  setAutoHide: (secs) => ipcRenderer.invoke('setAutoHide', secs),
  onTheme: subscribe('jarvis:theme'),
  onState: subscribe('jarvis:state'),
  onStream: subscribe('jarvis:stream'),
  onMode: subscribe('jarvis:mode'),
  onReset: subscribe('jarvis:reset'),
  onBrief: subscribe('jarvis:brief'),
  onStats: subscribe('jarvis:stats'),
  onAlert: subscribe('jarvis:alert'),
  control: {
    get: () => ipcRenderer.invoke('control:get'),
    set: (patch) => ipcRenderer.invoke('control:set', patch),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    forget: (q) => ipcRenderer.invoke('memory:forget', q),
  },
  monitorRecent: () => ipcRenderer.invoke('monitor:recent'),
  media: {
    pick: () => ipcRenderer.invoke('media:pick'),
    open: (file) => ipcRenderer.invoke('media:open', file),
  },
  dash: {
    weather: (c) => ipcRenderer.invoke('dash:weather', c),
    hardware: () => ipcRenderer.invoke('dash:hardware'),
    calList: () => ipcRenderer.invoke('dash:cal:list'),
    calAdd: (ev) => ipcRenderer.invoke('dash:cal:add', ev),
    calDel: (id) => ipcRenderer.invoke('dash:cal:del', id),
  },
  activity: {
    status: () => ipcRenderer.invoke('activity:status'),
    set: (on) => ipcRenderer.invoke('activity:set', on),
  },
  ping: () => ipcRenderer.send('ui:activity'),
  notify: (payload) => ipcRenderer.send('notch:notify', payload),
  voice: { say: (text) => ipcRenderer.invoke('voice:say', text) },
  reminders: {
    add: (item) => ipcRenderer.invoke('reminder:add', item),
    list: () => ipcRenderer.invoke('reminder:list'),
    clear: (id) => ipcRenderer.invoke('reminder:clear', id),
  },
  notes: {
    add: (text) => ipcRenderer.invoke('note:add', text),
    list: () => ipcRenderer.invoke('note:list'),
    clear: () => ipcRenderer.invoke('note:clear'),
  },
  onReminder: subscribe('jarvis:reminder'),
  app: { open: (target) => ipcRenderer.invoke('app:open', target) },
  web: { fetch: (url) => ipcRenderer.invoke('web:fetch', url) },
  system: { cmd: (cmd) => ipcRenderer.invoke('system:cmd', cmd) },
})
