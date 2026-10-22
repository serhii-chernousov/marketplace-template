/**
 * Domain event contract for order.placed.
 * Designed payload — not an ORM entity spread.
 */
export interface OrderPlacedEvent {
	eventId: string
	type: 'order.placed'
	occurredAt: string
	orderId: string
	userId: string
	totalCents: number
	/** Demo-only flag: consumer rejects without applying effect. */
	poison?: boolean
}

/**
 * Explicit order.placed contract built from scalars.
 * Do not spread an ORM entity — the table shape must not become the public API.
 */
export function toOrderPlacedEvent(order: {
	orderId: string
	userId: string
	totalCents: number
	eventId?: string
	occurredAt?: string
}): OrderPlacedEvent {
	return createOrderPlacedEvent(order)
}

export function createOrderPlacedEvent(input: {
	orderId: string
	userId: string
	totalCents: number
	eventId?: string
	occurredAt?: string
	poison?: boolean
}): OrderPlacedEvent {
	const event: OrderPlacedEvent = {
		eventId: input.eventId ?? crypto.randomUUID(),
		type: 'order.placed',
		occurredAt: input.occurredAt ?? new Date().toISOString(),
		orderId: input.orderId,
		userId: input.userId,
		totalCents: input.totalCents,
	}
	if (input.poison) {
		event.poison = true
	}
	return event
}
