export class PaymentsRepository {
	async capturedCents(orderId: string): Promise<number> {
		return orderId.length
	}
}
