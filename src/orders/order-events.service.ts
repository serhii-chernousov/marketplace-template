import { Injectable } from '@nestjs/common'
import { filter, Observable, Subject } from 'rxjs'

export interface OrderStatusEvent {
	id: number
	orderId: string
	status: string
}

const BUFFER_LIMIT = 50

interface OrderEventStream {
	nextId: number
	buffer: OrderStatusEvent[]
}

/**
 * In-process event bus for order status changes.
 * Subject fans out live events; each order has its own id sequence and replay buffer.
 */
@Injectable()
export class OrderEventsService {
	private readonly subject = new Subject<OrderStatusEvent>()
	private readonly streams = new Map<string, OrderEventStream>()

	publish(orderId: string, status: string): OrderStatusEvent {
		const stream = this.streamFor(orderId)
		const event: OrderStatusEvent = {
			id: stream.nextId,
			orderId,
			status,
		}
		stream.nextId += 1
		stream.buffer.push(event)
		if (stream.buffer.length > BUFFER_LIMIT) {
			stream.buffer.splice(0, stream.buffer.length - BUFFER_LIMIT)
		}
		this.subject.next(event)
		return event
	}

	replayAfter(orderId: string, lastEventId: number): OrderStatusEvent[] {
		const buffer = this.streams.get(orderId)?.buffer ?? []
		return buffer.filter((event) => event.id > lastEventId)
	}

	private streamFor(orderId: string): OrderEventStream {
		const existing = this.streams.get(orderId)
		if (existing) {
			return existing
		}
		const created: OrderEventStream = { nextId: 1, buffer: [] }
		this.streams.set(orderId, created)
		return created
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
