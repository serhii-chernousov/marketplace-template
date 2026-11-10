import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { DataSource, QueryFailedError } from 'typeorm'
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser, Public, Roles } from '../auth/decorators'
import { Product } from '../entities/product.entity'
import { RateLimit } from '../ratelimit/rate-limit.decorator'
import { ProblemException } from '../types/problem.exception'
import { ProductCardService } from './product-card.service'

interface CreateProductBody {
	name: string
	description?: string
	price_cents: number
	stock: number
}

const UNIQUE_VIOLATION = '23505'

@Controller('v1/products')
export class ProductsController {
	constructor(
		private readonly cards: ProductCardService,
		private readonly dataSource: DataSource,
	) {}

	@Public()
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

	@Post()
	@HttpCode(201)
	@Roles('seller', 'admin')
	async create(@CurrentUser() user: AuthUser, @Body() body: CreateProductBody) {
		const repo = this.dataSource.getRepository(Product)
		try {
			const product = await repo.save(
				repo.create({
					name: body.name,
					description: body.description ?? '',
					priceCents: body.price_cents,
					stock: body.stock,
					seller: { id: user.id },
				}),
			)
			return {
				id: product.id,
				name: product.name,
				description: product.description,
				price_cents: product.priceCents,
				stock: product.stock,
				seller_id: user.id,
			}
		} catch (err) {
			if (
				err instanceof QueryFailedError &&
				(err.driverError as { code?: string }).code === UNIQUE_VIOLATION
			) {
				throw new ProblemException(
					409,
					'https://marketplace.local/problems/product-name-taken',
					'Product name taken',
					`A product named "${body.name}" already exists`,
					'/v1/products',
				)
			}
			throw err
		}
	}
}
