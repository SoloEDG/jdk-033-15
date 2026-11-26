import { computed, onMounted, onUnmounted, ref } from 'vue'
import { course } from '../features/chart'
import { useWind } from '../features/wind'
import { useSail } from '../features/sail'
import { useJury } from '../features/jury'
import type { EventDraft } from '../features/jury'
import { useTide } from '../features/tide'
import { useLogbook } from '../features/logbook'
import type { Boat, Point, RaceEvent, RaceStatus, Sample } from '../shared/race'

const stepSize = .025
const maxDuration = 600

export function useRace() {
  const wind = useWind()
  const sail = useSail(course)
  const tide = useTide(course)
  const jury = useJury(course)
  const logbook = useLogbook()
  const status = ref<RaceStatus>('ready')
  const elapsed = ref(0)
  const focus = ref<Point | null>(null)
  const tideFocus = ref<Point | null>(null)
  const live = computed<Sample>(() => ({
    time: elapsed.value, boat: sail.boat.value, wind: wind.sample(elapsed.value),
    current: tide.current.value, nextGate: jury.nextGate.value, penalty: jury.penalty.value,
  }))
  const frame = computed(() => logbook.frame.value ?? live.value)
  const trail = computed(() => (logbook.selected.value?.samples ?? logbook.samples.value).map(sample => sample.boat.position))
  const active = computed(() => status.value === 'running' || status.value === 'paused')
  let animation = 0, last = 0, pending = 0
  /** 无潮流影子船位置：同一舵帆操作、零潮流的对照轨迹，用于识别被潮流改变的判罚 */
  let shadow: Point = { ...course.start }
  function clearFocus() {
    focus.value = null
    tideFocus.value = null
  }
  function reset() {
    status.value = 'ready'
    elapsed.value = pending = 0
    clearFocus()
    logbook.selected.value = null
    logbook.samples.value = []
    sail.reset()
    tide.reset(course.start)
    jury.reset()
    shadow = { ...course.start }
  }
  function start() {
    const mode = wind.mode.value
    reset()
    wind.set(mode)
    status.value = 'running'
    jury.add('start', '出发', 0, sail.boat.value.position)
    logbook.record(live.value, true)
  }
  function togglePause() {
    if (status.value === 'running') { status.value = 'paused'; sail.steer(0) }
    else if (status.value === 'paused') status.value = 'running'
    pending = 0
  }
  function end(result: 'abandoned' | 'finished') {
    if (!active.value) return
    if (result === 'abandoned') jury.add('abandon', '结束航次', elapsed.value, sail.boat.value.position)
    logbook.record(live.value, true)
    logbook.archive({
      courseId: course.id, windMode: wind.mode.value, status: result,
      duration: elapsed.value, penalty: jury.penalty.value, events: [...jury.events.value],
    })
    status.value = result
  }
  function tick() {
    const from = sail.boat.value
    // 船帆受力只跟着对水运动走；潮流另行推演出对地位移（按真实跨界次序分段）
    const sailed = sail.step(live.value.wind, stepSize)
    const drift = tide.advect(from.position, sailed.position, stepSize)
    const next: Boat = { ...sailed, position: drift.to }
    // 影子船只走对水位移，与真实船共享舵帆状态，用来对照“若无潮流”的航迹
    const shadowTo = { x: shadow.x + sailed.position.x - from.position.x, y: shadow.y + sailed.position.y - from.position.y }
    const verdict = jury.inspect(from.position, next.position, elapsed.value, stepSize, { from: shadow, to: shadowTo })
    shadow = shadowTo
    const drafts: EventDraft[] = [...verdict.created]
    if (!verdict.blocked) {
      // 未被拦回才提交跨界：碰撞停船的一拍不算真的越界
      tide.commit(drift)
      for (const crossing of drift.crossings) drafts.push({
        kind: 'tide',
        label: crossing.entering ? `进入${crossing.band.name}` : `离开${crossing.band.name}`,
        time: elapsed.value + crossing.fraction * stepSize,
        position: crossing.point,
        penalty: 0,
      })
    }
    // 潮流改变了判罚（与无流影子船对照结论不同）→ 记录交界点，回看可定位。
    // 只标会改变成绩的判罚（碰撞/偏航）：过门与冲线是必然事件，轨迹一有偏差就会错位，标注反而失真。
    const junction = tide.lastCrossing.value
    if (verdict.driftChanged && junction) {
      for (const draft of drafts) {
        if ((draft.kind === 'collision' || draft.kind === 'deviation') && !draft.tide) {
          draft.tide = { band: junction.band, at: { ...junction.point } }
        }
      }
    }
    drafts.sort((a, b) => a.time - b.time)
    jury.push(drafts)
    sail.boat.value = verdict.blocked ? { ...next, position: from.position, knots: 0 } : next
    elapsed.value += stepSize
    if (verdict.finish) {
      elapsed.value = verdict.finish.time
      sail.boat.value = { ...next, position: verdict.finish.position }
      end('finished')
      return
    }
    const markEvent = drafts.find(draft => draft.kind === 'mark' && draft.time < elapsed.value)
    if (markEvent) {
      logbook.record({ ...live.value, time: markEvent.time, wind: wind.sample(markEvent.time),
        boat: { ...next, position: markEvent.position } }, true)
    }
    logbook.record(live.value, drafts.some(draft => draft.time === elapsed.value))
    if (elapsed.value >= maxDuration) end('abandoned')
  }
  function loop(now: number) {
    if (last && status.value === 'running') {
      pending += Math.min(.2, (now - last) / 1000)
      while (pending >= stepSize && status.value === 'running') {
        pending -= stepSize
        tick()
      }
    }
    last = now
    animation = requestAnimationFrame(loop)
  }
  function keydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLElement && event.target.matches('input, select, button, textarea')) return
    if (status.value !== 'running') return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      sail.steer(event.key === 'ArrowLeft' ? -1 : 1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      sail.sheet(sail.boat.value.sheet + (event.key === 'ArrowUp' ? 2 : -2))
    }
  }
  function keyup(event: KeyboardEvent) {
    const released = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (released && sail.boat.value.rudder === released) sail.steer(0)
  }
  function suspend() { if (status.value === 'running') togglePause() }
  function locate(event: RaceEvent) {
    focus.value = event.position
    tideFocus.value = event.tide?.at ?? null
    if (logbook.selected.value) logbook.seek(event.time)
  }
  onMounted(() => {
    animation = requestAnimationFrame(loop)
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    window.addEventListener('blur', suspend)
  })
  onUnmounted(() => {
    cancelAnimationFrame(animation)
    window.removeEventListener('keydown', keydown)
    window.removeEventListener('keyup', keyup)
    window.removeEventListener('blur', suspend)
  })
  return { course, wind, sail, tide, jury, logbook, status, focus, tideFocus, frame, trail, active, start, togglePause, end, locate, clearFocus }
}
