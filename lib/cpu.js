'use strict'
/** CPU usage sampler, extracted so the arithmetic is testable without Electron. */

/**
 * @param {() => Array<{times:{user:number,nice:number,sys:number,idle:number,irq:number}}>} getCpus
 * @returns {() => number} percent 0–100, computed from the delta since the last call
 */
function sampler(getCpus = () => require('os').cpus()) {
  let last = null
  return function percent() {
    const now = getCpus()
    if (!Array.isArray(now) || now.length === 0) return 0
    if (!last) { last = now; return 0 }

    let idleDelta = 0
    let totalDelta = 0
    for (let i = 0; i < now.length; i++) {
      const a = (last[i] || now[i]).times
      const b = now[i].times
      const idle = b.idle - a.idle
      totalDelta += (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle
      idleDelta += idle
    }
    last = now
    if (totalDelta <= 0) return 0
    return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)))
  }
}

module.exports = { sampler }
