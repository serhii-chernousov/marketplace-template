import { PaymentsRepository } from '../payments/payments.repository'

export class OrderRefundService {
	constructor(private readonly payments: PaymentsRepository) {}

	refundableCents(orderId: string): Promise<number> {
		return this.payments.capturedCents(orderId)
	}
}
