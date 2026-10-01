/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	reporters: ['default'],
	maxWorkers: 1,
	testEnvironment: 'node',
	testTimeout: 120000,
	watchman: false,
	roots: ['<rootDir>/src', '<rootDir>/test'],
	testMatch: ['**/*.spec.ts'],
	transform: {
		'^.+\\.ts$': [
			'ts-jest',
			{ tsconfig: 'tsconfig.spec.json' },
		],
	},
}
