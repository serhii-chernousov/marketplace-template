import './transforms'
import { db } from './rds'
import { alb, targetGroupArn as tgArn } from './alb'
import { nat } from './nat'

export const dbIdentifier = db.identifier
export const albDnsName = alb.dnsName
export const targetGroupArn = tgArn
export const natGatewayId = nat?.id
