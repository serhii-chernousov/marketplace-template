import { Injectable } from '@nestjs/common'
import { filter, Observable, Subject } from 'rxjs'

export interface OrderStatusEvent {
	id: number
	orderId: string
	status: string
}

const BUFFER_LIMIT = 50

/**
 * In-process event bus for order status changes.
 * Subject fans out live events; a per-order buffer supports SSE Last-Event-ID replay.
 */
@Injectable()
export class OrderEventsService {
	private nextId = 1
	private readonly subject = new Subject<OrderStatusEvent>()
	private readonly buffers = new Map<string, OrderStatusEvent[]>()

	publish(orderId: string, status: string): OrderStatusEvent {
		const event: OrderStatusEvent = {
			id: this.nextId++,
			orderId,
			status,
		}
		const buffer = this.buffers.get(orderId) ?? []
		buffer.push(event)
		if (buffer.length > BUFFER_LIMIT) {
			buffer.splice(0, buffer.length - BUFFER_LIMIT)
		}
		this.buffers.set(orderId, buffer)
		this.subject.next(event)
		return event
	}

	replayAfter(orderId: string, lastEventId: number): OrderStatusEvent[] {
		const buffer = this.buffers.get(orderId) ?? []
		return buffer.filter((event) => event.id > lastEventId)
	}

	changes$(orderId: string): Observable<OrderStatusEvent> {
		return this.subject
			.asObservable()
			.pipe(filter((event) => event.orderId === orderId))
	}

	allChanges$(): Observable<OrderStatusEvent> {
		return this.subject.asObservable()
	}
}
