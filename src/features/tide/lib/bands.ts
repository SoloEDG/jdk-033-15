import { axis, dot, KNOTS_TO_UNITS, normalize, subtract } from '../../../shared/math'
import type { Boat, Current, Point, TideBand } from '../../../shared/race'

export interface TideCrossing {
  band: TideBand
  entering: boolean
  point: Point
  /** 在本次步长内发生的时间比例 0..1 */
  fraction: number
}

export interface DriftResult {
  to: Point
  crossings: TideCrossing[]
  /** 步长结束时的带内成员（供下一拍继续使用，保证迟滞稳定） */
  inside: string[]
  /** 本拍是否受到潮流推压 */
  influenced: boolean
  /** 本拍参与推压的带名 */
  bands: string[]
}

/**
 * 迟滞半宽（图单位）：越过 width/2 − HYSTERESIS 才进入，越过 width/2 + HYSTERESIS 才离开。
 * 贴界航行时成员状态不会在两种流速间来回跳变。
 */
const HYSTERESIS = 2
const EPS = 1e-9
const MAX_SPLITS = 10

export const bandNormal = (band: TideBand): Point => axis(band.bearing + 90)

/** 位置相对带中心线的有向距离（沿法向，正负区分两侧） */
export const bandDepth = (band: TideBand, p: Point): number => dot(subtract(p, band.center), bandNormal(band))

/** 带内潮流速度矢量（图单位/秒） */
export const bandVector = (band: TideBand): Point => {
  const v = axis(band.set)
  return { x: v.x * band.knots * KNOTS_TO_UNITS, y: v.y * band.knots * KNOTS_TO_UNITS }
}

/** 由当前成员带合成潮流（多带叠加，显示名取最强一条） */
export function combineCurrent(bands: TideBand[], inside: string[]): Current | null {
  let x = 0, y = 0, strongest: TideBand | null = null
  for (const band of bands) {
    if (!inside.includes(band.id)) continue
    const v = bandVector(band)
    x += v.x
    y += v.y
    if (!strongest || band.knots > strongest.knots) strongest = band
  }
  if (!strongest) return null
  return { set: normalize(Math.atan2(y, x) * 180 / Math.PI), knots: Math.hypot(x, y) / KNOTS_TO_UNITS, band: strongest.name }
}

/** 对水速度矢量 + 潮流矢量 = 对地速度矢量（节） */
export function groundVelocity(boat: Boat, current: Current | null): Point {
  const through = axis(boat.heading)
  const drift = current ? axis(current.set) : { x: 0, y: 0 }
  const knots = current?.knots ?? 0
  return { x: through.x * boat.knots + drift.x * knots, y: through.y * boat.knots + drift.y * knots }
}

export const groundSpeed = (boat: Boat, current: Current | null): number => {
  const v = groundVelocity(boat, current)
  return Math.hypot(v.x, v.y)
}

/**
 * 把一拍的“对水位移”与潮流漂移合成为对地位移。
 *
 * 不按到达点的流速整段套用，而是沿路径求出穿越带界的真实次序，在交界点切开：
 * 每一小段只使用该时刻所在水域的流速。这样穿过窄带又被推回时，进、出、再进
 * 都按实际顺序结算，原本擦过礁头的船不会被错误地瞬移进礁区。
 *
 * 带成员判定有迟滞（见 HYSTERESIS），交界附近来回贴界时状态稳定。
 */
export function advectThrough(bands: TideBand[], from: Point, waterTo: Point, dt: number, inside: string[]): DriftResult {
  const water = { x: (waterTo.x - from.x) / dt, y: (waterTo.y - from.y) / dt }
  const active = new Set(inside)
  const crossings: TideCrossing[] = []
  const names = new Set<string>()
  let influenced = false
  let pos = { ...from }
  let t = 0
  let vx = water.x, vy = water.y
  for (let splits = 0; t < dt - EPS && splits < MAX_SPLITS; splits++) {
    vx = water.x
    vy = water.y
    for (const band of bands) {
      if (!active.has(band.id)) continue
      const v = bandVector(band)
      vx += v.x
      vy += v.y
      influenced = true
      names.add(band.name)
    }
    // 找本段内最早到达的进/出阈值线（有向深度随时间线性变化，解析求解）
    let hitT = Infinity
    let hitBand: TideBand | null = null
    for (const band of bands) {
      const limit = band.width / 2 + (active.has(band.id) ? HYSTERESIS : -HYSTERESIS)
      const n = bandNormal(band)
      const d0 = dot(subtract(pos, band.center), n)
      const dn = vx * n.x + vy * n.y
      if (Math.abs(dn) < EPS) continue
      for (const side of [1, -1]) {
        const tt = t + (side * limit - d0) / dn
        if (tt > t + EPS && tt < hitT) { hitT = tt; hitBand = band }
      }
    }
    const stop = Math.min(hitT, dt)
    pos = { x: pos.x + vx * (stop - t), y: pos.y + vy * (stop - t) }
    t = stop
    if (!hitBand || hitT > dt + EPS) break
    crossings.push({ band: hitBand, entering: !active.has(hitBand.id), point: { ...pos }, fraction: t / dt })
    if (active.has(hitBand.id)) active.delete(hitBand.id)
    else active.add(hitBand.id)
  }
  if (t < dt - EPS) pos = { x: pos.x + vx * (dt - t), y: pos.y + vy * (dt - t) }
  return { to: pos, crossings, inside: [...active], influenced, bands: [...names] }
}

/** 带的外轮廓（供海图绘制的平行四边形，超出图幅由 SVG 视口裁剪） */
export function bandOutline(band: TideBand, length = 800): Point[] {
  const a = axis(band.bearing)
  const n = bandNormal(band)
  const half = band.width / 2, l = length / 2
  return [
    { x: band.center.x - a.x * l - n.x * half, y: band.center.y - a.y * l - n.y * half },
    { x: band.center.x + a.x * l - n.x * half, y: band.center.y + a.y * l - n.y * half },
    { x: band.center.x + a.x * l + n.x * half, y: band.center.y + a.y * l + n.y * half },
    { x: band.center.x - a.x * l + n.x * half, y: band.center.y - a.y * l + n.y * half },
  ]
}

/** 沿带走向的流向箭头位置 */
export function flowArrows(band: TideBand, offsets: number[]): Point[] {
  const a = axis(band.bearing)
  return offsets.map(o => ({ x: band.center.x + a.x * o, y: band.center.y + a.y * o }))
}

/** 带名标签的放置点（偏离航线与礁区的空阔处） */
export function bandLabelAt(band: TideBand): Point {
  const a = axis(band.bearing)
  const n = bandNormal(band)
  return { x: band.center.x - a.x * 230 - n.x * 26, y: band.center.y - a.y * 230 - n.y * 26 }
}
