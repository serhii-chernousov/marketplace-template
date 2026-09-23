import { z } from 'zod'

export const envSchema = z.object({
	PORT: z.coerce.number().int().min(1).max(65535),
	DB_HOST: z.string().min(1),
	DB_PORT: z.coerce.number().int().min(1).max(65535),
	DB_USER: z.string().min(1),
	DB_PASSWORD: z.string().min(1),
	DB_NAME: z.string().min(1),
	DB_URL: z.string().min(1),
	LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
	TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
})

export type Env = z.infer<typeof envSchema>

export function validate(raw: Record<string, unknown>): Env {
	const parsed = envSchema.safeParse(raw)
	if (!parsed.success) {
		const lines = parsed.error.issues
			.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
			.join('\n')
		throw new Error(
			`Invalid configuration:\n${lines}\nCompare your .env with .env.example.`,
		)
	}
	return parsed.data
}
