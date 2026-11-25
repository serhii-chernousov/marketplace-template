import * as aws from '@pulumi/aws'
import { vpc } from './network'

function group(name: string, description: string) {
	return new aws.ec2.SecurityGroup(name, {
		vpcId: vpc.id,
		description,
		tags: { Name: `hw31-${name}` },
	})
}

export const albSg = group('alb', 'Internet-facing load balancer')
export const appSg = group('app', 'Workloads behind the load balancer')
export const dbSg = group('db', 'PostgreSQL in private subnets')

// 80 from anywhere: the ALB is the only public entry point; no domain, so no TLS listener.
new aws.vpc.SecurityGroupIngressRule('alb-http', {
	securityGroupId: albSg.id,
	ipProtocol: 'tcp',
	fromPort: 80,
	toPort: 80,
	cidrIpv4: '0.0.0.0/0',
})
// Outbound only into the VPC: the ALB forwards to targets, never to the internet.
new aws.vpc.SecurityGroupEgressRule('alb-to-vpc', {
	securityGroupId: albSg.id,
	ipProtocol: 'tcp',
	fromPort: 0,
	toPort: 65535,
	cidrIpv4: vpc.cidrBlock,
})

// 3000 (the API port) only from the ALB, so workloads are unreachable directly.
new aws.vpc.SecurityGroupIngressRule('app-from-alb', {
	securityGroupId: appSg.id,
	ipProtocol: 'tcp',
	fromPort: 3000,
	toPort: 3000,
	referencedSecurityGroupId: albSg.id,
})
// Outbound only to PostgreSQL inside the VPC.
new aws.vpc.SecurityGroupEgressRule('app-to-db', {
	securityGroupId: appSg.id,
	ipProtocol: 'tcp',
	fromPort: 5432,
	toPort: 5432,
	referencedSecurityGroupId: dbSg.id,
})

// 5432 only from the app group: the database has no path from the internet or the ALB.
new aws.vpc.SecurityGroupIngressRule('db-from-app', {
	securityGroupId: dbSg.id,
	ipProtocol: 'tcp',
	fromPort: 5432,
	toPort: 5432,
	referencedSecurityGroupId: appSg.id,
})
