import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { requireEnv } from './env'

const { BUDGET_EMAIL } = requireEnv(['BUDGET_EMAIL'])

export const budget = new aws.budgets.Budget('monthly-cap', {
	budgetType: 'COST',
	timeUnit: 'MONTHLY',
	limitAmount: '5',
	limitUnit: 'USD',
	notifications: [
		{
			notificationType: 'ACTUAL',
			comparisonOperator: 'GREATER_THAN',
			threshold: 20,
			thresholdType: 'PERCENTAGE',
			// Secret so the committed `pulumi stack export` carries ciphertext, not the address.
			subscriberEmailAddresses: [pulumi.secret(BUDGET_EMAIL)],
		},
	],
})
