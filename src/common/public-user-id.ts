import type { DataSource } from 'typeorm'
import { User } from '../entities/user.entity'

/** Seed accounts keep their short ДЗ #09 ids in API payloads and in-memory listings. */
const SEED_ALIASES: Record<string, string> = {
	'buyer-1': 'buyer1@shop.local',
	'buyer-2': 'buyer2@shop.local',
	'buyer-3': 'buyer3@shop.local',
	'buyer-4': 'buyer4@shop.local',
	'buyer-5': 'buyer5@shop.local',
	'seller-1': 'seller1@shop.local',
	'seller-2': 'seller2@shop.local',
}

export function publicUserId(email: string): string {
	for (const [alias, aliasEmail] of Object.entries(SEED_ALIASES)) {
		if (aliasEmail === email) {
			return alias
		}
	}
	return email
}

export async function publicUserIdOf(
	dataSource: DataSource,
	userId: string,
): Promise<string> {
	const user = await dataSource
		.getRepository(User)
		.findOneByOrFail({ id: userId })
	return publicUserId(user.email)
}
