export interface Point { x: number; y: number }

export interface Gate {
  id: string
  name: string
  center: Point
  bearing: number
  width: number
  buoySide: -1 | 1
  approach?: { center: Point; bearing: number; width: number }
}

export interface Course {
  id: string
  name: string
  size: Point
  start: Point
  heading: number
  gates: Gate[]
  hazards: { id: string; center: Point; radius: number }[]
  tides: TideBand[]
}

/** 潮纹带：一条横推船身的潮流带，bearing 为带的走向，set 为流向（图坐标角），knots 为流速 */
export interface TideBand {
  id: string
  name: string
  center: Point
  bearing: number
  width: number
  set: number
  knots: number
}

/** 船当前受到的合成潮流；band 为最强来源带名，null 表示在潮流水域外 */
export interface Current { set: number; knots: number; band: string | null }

export type WindMode = 'steady' | 'shifting'
export interface Wind { bearing: number; knots: number }
export interface Boat { position: Point; heading: number; knots: number; sheet: number; rudder: number }
export type RaceStatus = 'ready' | 'running' | 'paused' | 'finished' | 'abandoned'
export type EventKind = 'start' | 'mark' | 'collision' | 'deviation' | 'finish' | 'abandon' | 'tide'
export interface RaceEvent {
  id: string
  time: number
  kind: EventKind
  position: Point
  label: string
  penalty: number
  /** 潮流改变了这次判罚时，记录来源带与交界点（船被推入/推出的边界位置） */
  tide?: { band: string; at: Point }
}
export interface Sample {
  time: number
  boat: Boat
  wind: Wind
  current: Current | null
  nextGate: number
  penalty: number
}
export interface Voyage {
  id: string
  date: string
  courseId: string
  windMode: WindMode
  status: 'finished' | 'abandoned'
  duration: number
  penalty: number
  samples: Sample[]
  events: RaceEvent[]
}
