import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{
		ignores: [
			'dist/**',
			'coverage/**',
			'infra/**',
			'gates/fixtures/**',
			'node_modules/**',
			'pacts/**',
		],
	},
	{
		files: ['src/**/*.ts', 'test/**/*.ts'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ ignoreRestSiblings: true },
			],
		},
	},
	{
		// Demo scripts preset exitCode = 1 so any throw before the end reports failure.
		files: ['src/demo/**/*.ts'],
		rules: { 'no-useless-assignment': 'off' },
	},
)
