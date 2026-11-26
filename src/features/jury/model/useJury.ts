import { ref } from 'vue'
import { inspectWater, isOffCourse } from '../../chart'
import type { Course, EventKind, Point, RaceEvent } from '../../../shared/race'

import { gateCrossing } from '../lib/crossing'

export type EventDraft = Omit<RaceEvent, 'id'>

export function useJury(course: Course) {
  const nextGate = ref(0)
  const penalty = ref(0)
  const events = ref<RaceEvent[]>([])
  let contacts = new Set<string>()
  let outside = false
  let approached = false
  let seq = 0

  function push(drafts: EventDraft | EventDraft[]) {
    for (const draft of [drafts].flat()) {
      penalty.value += draft.penalty
      events.value.push({ ...draft, id: String(++seq), position: { ...draft.position } })
    }
  }
  function add(kind: EventKind, label: string, time: number, position: Point, seconds = 0) {
    push({ kind, label, time, position, penalty: seconds })
  }
  function reset() {
    nextGate.value = penalty.value = 0
    events.value = []
    contacts = new Set()
    outside = false
    approached = false
    seq = 0
  }
  /**
   * 检查 from→to 的对地位移。shadow 为同一拍的“无潮流影子船”航段：
   * 用它做对照，能标出哪些判罚是被潮流改变的（driftChanged）。
   */
  function inspect(from: Point, to: Point, start: number, dt: number, shadow?: { from: Point; to: Point }) {
    const created: EventDraft[] = []
    let driftChanged = false
    const gate = course.gates[nextGate.value]
    if (!gate) return { blocked: false, finish: null, created, driftChanged }
    const newContacts = new Set(inspectWater(course, to))
    const blamed = [...newContacts].filter(name => !contacts.has(name))
    for (const name of blamed) created.push({ kind: 'collision', label: `碰撞 · ${name}`, time: start + dt, position: { ...from }, penalty: 5 })
    if (newContacts.size) {
      for (const name of newContacts) contacts.add(name)
      if (shadow) {
        const shadowContacts = new Set(inspectWater(course, shadow.to))
        driftChanged = blamed.some(name => !shadowContacts.has(name))
      }
      return { blocked: true, finish: null, created, driftChanged }
    }
    if (contacts.size) {
      const nearby = new Set(inspectWater(course, to, 3))
      for (const name of contacts) if (!nearby.has(name)) contacts.delete(name)
    }
    if (gate.approach) {
      if (gateCrossing(gate.approach, to, from)) approached = false
      if (gateCrossing(gate.approach, from, to)) approached = true
    }
    const hit = (!gate.approach || approached) ? gateCrossing(gate, from, to) : null
    const legStart = nextGate.value === 0 ? course.start : course.gates[nextGate.value - 1].center
    const offCourse = isOffCourse(legStart, gate, to)
    if (hit) {
      if (shadow) {
        const shadowHit = (!gate.approach || approached) ? gateCrossing(gate, shadow.from, shadow.to) : null
        driftChanged = !shadowHit
      }
      nextGate.value++
      approached = false
      outside = false
      const time = start + dt * hit.fraction
      if (nextGate.value === course.gates.length) {
        created.push({ kind: 'finish', label: '冲过终点', time, position: hit.point, penalty: 0 })
        return { blocked: false, finish: { time, position: hit.point }, created, driftChanged }
      }
      created.push({ kind: 'mark', label: `通过 ${gate.name}`, time, position: hit.point, penalty: 0 })
    } else {
      if (offCourse && !outside) {
        created.push({ kind: 'deviation', label: '偏离航段', time: start + dt, position: { ...to }, penalty: 3 })
        if (shadow) driftChanged = !isOffCourse(legStart, gate, shadow.to)
      }
      outside = offCourse
    }
    return { blocked: false, finish: null, created, driftChanged }
  }
  return { nextGate, penalty, events, reset, add, push, inspect }
}
