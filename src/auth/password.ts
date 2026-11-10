import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEY_LENGTH = 32
/** N=2^14, r=8 stays under Node's default 32 MiB scrypt maxmem. */
const PARAMS = { N: 16384, r: 8, p: 1 }

function derive(
	password: string,
	salt: Buffer,
	params: { N: number; r: number; p: number },
): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scrypt(password, salt, KEY_LENGTH, params, (err, key) =>
			err ? reject(err) : resolve(key),
		),
	)
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16)
	const key = await derive(password, salt, PARAMS)
	const { N, r, p } = PARAMS
	return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

let dummyHash: Promise<string> | undefined

/** Unknown users are checked against a dummy hash so timing does not reveal which emails exist. */
export async function verifyPassword(
	password: string,
	stored: string | null | undefined,
): Promise<boolean> {
	dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
	const matches = await compare(password, stored ?? (await dummyHash))
	return Boolean(stored) && matches
}

async function compare(password: string, stored: string): Promise<boolean> {
	const [scheme, N, r, p, salt, expected] = stored.split('$')
	if (scheme !== 'scrypt' || !expected) {
		return false
	}
	const expectedKey = Buffer.from(expected, 'base64url')
	const key = await derive(password, Buffer.from(salt, 'base64url'), {
		N: Number(N),
		r: Number(r),
		p: Number(p),
	})
	return key.length === expectedKey.length && timingSafeEqual(key, expectedKey)
}
