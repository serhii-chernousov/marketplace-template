import { createHash } from 'crypto'

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
		eventId: input.eventId ?? orderPlacedEventId(input.orderId),
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

/**
 * Same order → same event id, so a re-run of checkout or relay cannot mint a
 * second event that slips past the consumer's dedup.
 */
export function orderPlacedEventId(orderId: string): string {
	const hex = createHash('sha1')
		.update(`order.placed:${orderId}`)
		.digest('hex')
		.slice(0, 32)
	const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${variant}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join('-')
}
