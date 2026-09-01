import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemaSrc = readFileSync(join(root, 'src/config/env.schema.ts'), 'utf8')
const objectBody = schemaSrc.match(/z\.object\(\{([\s\S]*?)\n\}\)/)?.[1]
if (!objectBody) {
	console.error('✗ Could not parse envSchema in src/config/env.schema.ts')
	process.exit(1)
}

const schemaKeys = [...objectBody.matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)]
	.map((m) => m[1])
	.sort()
const fileKeys = Object.keys(
	parse(readFileSync(join(root, '.env.example'))),
).sort()

const missing = schemaKeys.filter((k) => !fileKeys.includes(k))
const extra = fileKeys.filter((k) => !schemaKeys.includes(k))

if (missing.length || extra.length) {
	if (missing.length)
		console.error(`✗ Missing in .env.example: ${missing.join(', ')}`)
	if (extra.length)
		console.error(
			`✗ Extra in .env.example (not in schema): ${extra.join(', ')}`,
		)
	process.exit(1)
}
console.log(
	`✓ .env.example synchronized with schema (${schemaKeys.length} variables)`,
)
