import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { GUARD_TAGS } from './guard'

const GITHUB_ISSUER = 'token.actions.githubusercontent.com'
export const CI_ROLE_NAME = 'hw31-teardown'

const config = new pulumi.Config()
// GitHub issues `sub` as repo:<owner>@<owner id>/<repo>@<repo id>:...; the ids
// survive renames, so a recreated repo with the same name cannot assume the role.
const repoSubject = config.require('githubRepoSubject')
const branches = config.requireObject<string[]>('ciBranches')

const account = aws.getCallerIdentityOutput().accountId
const region = aws.getRegionOutput().region

const github = new aws.iam.OpenIdConnectProvider('github', {
	url: `https://${GITHUB_ISSUER}`,
	clientIdLists: ['sts.amazonaws.com'],
	tags: GUARD_TAGS,
})

export const ciRole = new aws.iam.Role('teardown', {
	name: CI_ROLE_NAME,
	description: 'Assumed by the teardown GitHub Actions workflow via OIDC',
	maxSessionDuration: 3600,
	tags: GUARD_TAGS,
	assumeRolePolicy: pulumi.jsonStringify({
		Version: '2012-10-17',
		Statement: [
			{
				Effect: 'Allow',
				Principal: { Federated: github.arn },
				Action: 'sts:AssumeRoleWithWebIdentity',
				Condition: {
					StringEquals: { [`${GITHUB_ISSUER}:aud`]: 'sts.amazonaws.com' },
					StringLike: {
						[`${GITHUB_ISSUER}:sub`]: branches.map(
							(branch) => `repo:${repoSubject}:ref:refs/heads/${branch}`,
						),
					},
				},
			},
		],
	}),
})

const arn = (service: string, resource: string) =>
	pulumi.interpolate`arn:aws:${service}:${region}:${account}:${resource}`

export const CI_POLICY_NAME = 'teardown'

new aws.iam.RolePolicy('teardown', {
	role: ciRole.name,
	name: CI_POLICY_NAME,
	policy: pulumi.jsonStringify({
		Version: '2012-10-17',
		Statement: [
			{
				// Describe/List calls have no resource-level permissions in IAM.
				Sid: 'ReadForDestroyAndEmptinessChecks',
				Effect: 'Allow',
				Action: [
					'tag:GetResources',
					'rds:DescribeDBInstances',
					'rds:DescribeDBSubnetGroups',
					'elasticloadbalancing:DescribeLoadBalancers',
					'elasticloadbalancing:DescribeListeners',
					'elasticloadbalancing:DescribeTargetGroups',
					'elasticloadbalancing:DescribeTargetHealth',
					'elasticloadbalancing:DescribeTags',
					'ec2:DescribeNatGateways',
					'ec2:DescribeAddresses',
					'ec2:DescribeVpcs',
					'ec2:DescribeSubnets',
					'ec2:DescribeRouteTables',
					'ec2:DescribeInternetGateways',
					'ec2:DescribeSecurityGroups',
					'ec2:DescribeSecurityGroupRules',
					'ec2:DescribeNetworkInterfaces',
				],
				Resource: '*',
			},
			{
				Sid: 'DeleteDatabase',
				Effect: 'Allow',
				Action: ['rds:DeleteDBInstance', 'rds:DeleteDBSubnetGroup'],
				Resource: [arn('rds', 'db:*'), arn('rds', 'subgrp:*')],
			},
			{
				Sid: 'DeleteLoadBalancer',
				Effect: 'Allow',
				Action: [
					'elasticloadbalancing:DeleteLoadBalancer',
					'elasticloadbalancing:DeleteListener',
					'elasticloadbalancing:DeleteTargetGroup',
					'elasticloadbalancing:DeregisterTargets',
				],
				Resource: arn('elasticloadbalancing', '*'),
			},
			{
				Sid: 'DeleteLambdaTarget',
				Effect: 'Allow',
				Action: [
					'lambda:GetFunction',
					'lambda:GetPolicy',
					'lambda:DeleteFunction',
					'lambda:RemovePermission',
				],
				Resource: arn('lambda', 'function:hw31-demo-*'),
			},
			{
				Sid: 'DeleteLambdaLogs',
				Effect: 'Allow',
				Action: ['logs:DeleteLogGroup'],
				Resource: arn('logs', 'log-group:/aws/lambda/hw31-demo-*'),
			},
			{
				// Scoped to the demo prefix so the role can never delete itself.
				Sid: 'DeleteLambdaExecutionRole',
				Effect: 'Allow',
				Action: [
					'iam:GetRole',
					'iam:ListRolePolicies',
					'iam:ListAttachedRolePolicies',
					'iam:ListInstanceProfilesForRole',
					'iam:DetachRolePolicy',
					'iam:DeleteRolePolicy',
					'iam:DeleteRole',
				],
				Resource: pulumi.interpolate`arn:aws:iam::${account}:role/hw31-demo-*`,
			},
			{
				Sid: 'DeleteNatAndNetwork',
				Effect: 'Allow',
				Action: [
					'ec2:DeleteNatGateway',
					'ec2:DisassociateAddress',
					'ec2:ReleaseAddress',
					'ec2:DeleteRoute',
					'ec2:DisassociateRouteTable',
					'ec2:DeleteRouteTable',
					'ec2:DetachInternetGateway',
					'ec2:DeleteInternetGateway',
					'ec2:RevokeSecurityGroupIngress',
					'ec2:RevokeSecurityGroupEgress',
					'ec2:DeleteSecurityGroup',
					'ec2:DeleteSubnet',
					'ec2:DeleteVpc',
				],
				Resource: arn('ec2', '*'),
			},
		],
	}),
})
