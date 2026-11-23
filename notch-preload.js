'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const subscribe = (channel) => (cb) => {
  const handler = (_event, ...args) => { try { cb(...args) } catch (e) { console.error(e) } }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('notch', {
  hover: (v) => ipcRenderer.send('notch:hover', !!v),
  ping: () => ipcRenderer.send('notch:ping'),
  onStats: subscribe('jarvis:stats'),
  onJarvis: subscribe('notch:jarvis'),
  onShow: subscribe('notch:show'),
  onHide: subscribe('notch:hide'),
  onNotify: subscribe('notch:notify'),
  dash: {
    weather: (city) => ipcRenderer.invoke('dash:weather', city),
    hardware: () => ipcRenderer.invoke('dash:hardware'),
    calList: () => ipcRenderer.invoke('dash:cal:list'),
  },
  media: {
    pick: () => ipcRenderer.invoke('media:pick'),
    open: (file) => ipcRenderer.invoke('media:open', file),
  },
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
    history: () => ipcRenderer.invoke('clipboard:history'),
    clear: () => ipcRenderer.invoke('clipboard:clear'),
  },
  uptime: () => ipcRenderer.invoke('system:uptime'),
  control: {
    get: () => ipcRenderer.invoke('control:get'),
    set: (patch) => ipcRenderer.invoke('control:set', patch),
  },
  summon: () => ipcRenderer.send('notch:summon'),
  newChat: () => ipcRenderer.send('notch:newchat'),
  copy: (text) => ipcRenderer.invoke('copy', text),
})
