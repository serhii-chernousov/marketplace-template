import { z } from 'zod'
import { signingKeyPairProblem } from '../auth/auth-keys'

export const envSchema = z.object({
	PORT: z.coerce.number().int().min(1).max(65535),
	DB_HOST: z.string().min(1),
	DB_PORT: z.coerce.number().int().min(1).max(65535),
	DB_USER: z.string().min(1),
	DB_PASSWORD: z.string().min(1),
	DB_NAME: z.string().min(1),
	DB_URL: z.string().min(1),
	BROKER_URL: z.string().min(1),
	REDIS_URL: z.string().min(1).optional(),
	REDIS_QUEUE_URL: z.string().min(1).optional(),
	LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
	TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
})

/** No defaults on purpose: a default signing key is a key committed to git. */
export const authEnvSchema = z.object({
	JWT_PRIVATE_KEY: z.string().min(1),
	JWT_PUBLIC_KEY: z.string().min(1),
	JWT_KID: z.string().min(1),
	REFRESH_TOKEN_PEPPER: z.string().min(32),
})

const apiEnvSchema = envSchema
	.extend(authEnvSchema.shape)
	.superRefine((env, ctx) => {
		const problem = signingKeyPairProblem(
			env.JWT_PRIVATE_KEY,
			env.JWT_PUBLIC_KEY,
		)
		if (problem) {
			ctx.addIssue({
				code: 'custom',
				path: [problem.variable],
				message: problem.message,
			})
		}
	})

export type Env = z.infer<typeof envSchema>
export type ApiEnv = z.infer<typeof apiEnvSchema>

function parseEnv<S extends z.ZodType>(
	schema: S,
	raw: Record<string, unknown>,
): z.infer<S> {
	const parsed = schema.safeParse(raw)
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

export const validateApiEnv = (raw: Record<string, unknown>): ApiEnv =>
	parseEnv(apiEnvSchema, raw)

/** The worker never signs tokens, so it does not get the signing key. */
export const validateWorkerEnv = (raw: Record<string, unknown>): Env =>
	parseEnv(envSchema, raw)
