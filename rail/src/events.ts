// A tiny in-process event bus. The dashboard subscribes over SSE, tests read `history`.
import { EventEmitter } from 'node:events'

export type WorldEventType =
  | 'chain'
  | 'pet'
  | 'pet.chat'
  | 'pet.purchase'
  | 'pet.income'
  | 'soul'
  | 'guardian.request'
  | 'guardian.decision'
  | 'error'

export interface WorldEvent {
  id: number
  at: string
  type: WorldEventType
  message: string
  data?: unknown
}

export class EventBus {
  private readonly emitter = new EventEmitter()
  private nextId = 1
  readonly history: WorldEvent[] = []

  emit(type: WorldEventType, message: string, data?: unknown): WorldEvent {
    const event: WorldEvent = { id: this.nextId++, at: new Date().toISOString(), type, message, data }
    this.history.push(event)
    if (this.history.length > 500) this.history.shift()
    this.emitter.emit('event', event)
    return event
  }

  subscribe(listener: (event: WorldEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
