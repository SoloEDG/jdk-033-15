import { computed, ref, shallowRef } from 'vue'
import type { Course, Point } from '../../../shared/race'
import { advectThrough, bandDepth, combineCurrent } from '../lib/bands'
import type { DriftResult } from '../lib/bands'

export function useTide(course: Course) {
  /** 已提交的带内成员（带迟滞，跨拍保持，贴界时稳定） */
  const inside = ref<string[]>([])
  /** 最近一次跨界（判罚溯源用的交界点） */
  const lastCrossing = shallowRef<{ band: string; point: Point } | null>(null)
  /** 当前合成潮流（仪表显示对水/对地速度的依据） */
  const current = computed(() => combineCurrent(course.tides, inside.value))

  function reset(position: Point) {
    inside.value = course.tides.filter(band => Math.abs(bandDepth(band, position)) <= band.width / 2).map(band => band.id)
    lastCrossing.value = null
  }
  /** 纯几何推算：不改动成员状态，由 commit 提交（碰撞被拦回的一拍会被丢弃） */
  const advect = (from: Point, waterTo: Point, dt: number): DriftResult =>
    advectThrough(course.tides, from, waterTo, dt, inside.value)
  function commit(result: DriftResult) {
    inside.value = result.inside
    const last = result.crossings.at(-1)
    if (last) lastCrossing.value = { band: last.band.name, point: { ...last.point } }
  }
  reset(course.start)
  return { inside, current, lastCrossing, reset, advect, commit }
}
