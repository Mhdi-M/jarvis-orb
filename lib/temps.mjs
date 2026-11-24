/* Temperature probes for the hardware panel.
 *
 * Windows exposes no unified sensor API, so each vendor path is read separately:
 *   - GPU:            nvidia-smi
 *   - CPU (package):  WMI MSAcpi_ThermalZoneTemperature (tenths of a kelvin)
 *   - SSD / NVMe:     Get-StorageReliabilityCounter
 *
 * Every parser is pure and unit tested against real command output shapes.
 */

const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** WMI reports tenths of a kelvin: 3012 -> 27.9 C */
export function kelvinTenthsToC(raw) {
  const v = num(raw)
  if (v == null || v <= 0) return null
  const c = v / 10 - 273.15
  if (c < -40 || c > 150) return null
  return Math.round(c * 10) / 10
}

/** `nvidia-smi --query-gpu=temperature.gpu,name,utilization.gpu --format=csv,noheader,nounits` */
export function parseNvidiaSmi(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0]
  if (!line) return null
  const parts = line.split(',').map((p) => p.trim())
  const temp = num(parts[0])
  if (temp == null || temp <= 0 || temp > 130) return null
  const name = parts[1] && parts[1] !== '[N/A]' ? parts[1] : ''
  const util = num(parts[2])
  return { temp, name, util: util == null || util < 0 ? null : util }
}

/** `Get-CimInstance MSAcpi_ThermalZoneTemperature` -> CurrentTemperature : 3012 */
export function parseThermalZone(text) {
  const m = String(text || '').match(/CurrentTemperature\s*:?\s*(-?\d+)/i)
  if (!m) return null
  return kelvinTenthsToC(m[1])
}

/** `Get-PhysicalDisk | Get-StorageReliabilityCounter | Select -Expand Temperature` */
export function parseStorageTemp(text) {
  const nums = String(text || '').match(/-?\d+/g) || []
  for (const raw of nums) {
    const v = num(raw)
    if (v == null) continue
    if (v > 0 && v < 110) return v
  }
  return null
}

/** which colour band a reading falls in: cool / warm / hot */
export function tempBand(c) {
  if (c == null) return 'none'
  if (c >= 85) return 'hot'
  if (c >= 70) return 'warm'
  return 'cool'
}

/** short label for the sidebar: "58°C" / "n/a" */
export function tempLabel(c) {
  return c == null ? 'n/a' : Math.round(c) + '\u00b0C'
}

export default { kelvinTenthsToC, parseNvidiaSmi, parseThermalZone, parseStorageTemp, tempBand, tempLabel }
