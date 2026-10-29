import { Module } from '@nestjs/common'
import { ProductCardRepository } from './product-card.repository'
import { ProductCardService } from './product-card.service'
import { ProductsController } from './products.controller'

@Module({
	controllers: [ProductsController],
	providers: [ProductCardService, ProductCardRepository],
	exports: [ProductCardService],
})
export class CatalogModule {}
