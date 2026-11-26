interface OrderLine {
	priceCents: number
	quantity: number
}

export function orderTotalCents(lines: OrderLine[]): number {
	return lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0)
}
