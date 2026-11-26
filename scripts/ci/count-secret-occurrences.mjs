#!/usr/bin/env node
// Prints how many times any application secret value appears in the given
// files. Only the count is printed; the values never leave this process.
import { readFileSync } from 'node:fs'

const SECRET_NAMES = [
	'DB_PASSWORD',
	'REDIS_PASSWORD',
	'BROKER_PASSWORD',
	'STORAGE_ACCESS_KEY',
	'STORAGE_SECRET_KEY',
	'JWT_PRIVATE_KEY',
	'REFRESH_TOKEN_PEPPER',
]

const files = process.argv.slice(2)
if (files.length === 0) {
	console.error('usage: count-secret-occurrences.mjs <file>...')
	process.exit(2)
}

const values = SECRET_NAMES.map((name) => process.env[name]).filter(Boolean)
if (values.length !== SECRET_NAMES.length) {
	console.error(
		'not every application secret is in the environment; run through scripts/with-secrets.sh',
	)
	process.exit(2)
}

let count = 0
for (const file of files) {
	const text = readFileSync(file, 'utf8')
	for (const value of values) count += text.split(value).length - 1
}
console.log(count)
