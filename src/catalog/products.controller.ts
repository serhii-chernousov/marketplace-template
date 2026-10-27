import { Controller, Get, Param } from '@nestjs/common'
import { RateLimit } from '../ratelimit/rate-limit.decorator'
import { ProblemException } from '../types/problem.exception'
import { ProductCardService } from './product-card.service'

@Controller('v1/products')
export class ProductsController {
	constructor(private readonly cards: ProductCardService) {}

	@Get(':id')
	@RateLimit({ limit: 120, windowMs: 60_000 })
	async getCard(@Param('id') id: string) {
		const card = await this.cards.getCard(id)
		if (!card) {
			throw new ProblemException(
				404,
				'https://marketplace.local/problems/product-not-found',
				'Product not found',
				'Product with the given id does not exist',
				`/v1/products/${id}`,
			)
		}
		return {
			id: card.id,
			name: card.name,
			stock: card.stock,
			price_cents: card.priceCents,
			rating: card.rating,
			order_lines: card.orderLines,
		}
	}
}
