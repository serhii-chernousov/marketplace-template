import { budget } from './budget'
import { privateSubnets, publicSubnets, subnetIds, vpc } from './network'
import { albSg, appSg, dbSg } from './security'
import { CI_POLICY_NAME, ciRole } from './ci-identity'

export const budgetName = budget.name
export const vpcId = vpc.id
export const vpcCidr = vpc.cidrBlock
export const publicSubnetIds = subnetIds(publicSubnets)
export const privateSubnetIds = subnetIds(privateSubnets)
export const albSgId = albSg.id
export const appSgId = appSg.id
export const dbSgId = dbSg.id
export const ciRoleArn = ciRole.arn
export const ciRoleName = ciRole.name
export const ciPolicyName = CI_POLICY_NAME
