import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { base } from './base'

const FUNCTION_NAME = 'hw31-demo-health'

const HANDLER = `export const handler = async (event) => ({
  statusCode: 200,
  statusDescription: '200 OK',
  isBase64Encoded: false,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: true, path: event.path }),
})
`

const role = new aws.iam.Role('lambda', {
	name: 'hw31-demo-lambda',
	assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
		Service: 'lambda.amazonaws.com',
	}),
})
new aws.iam.RolePolicyAttachment('lambda-logs', {
	role: role.name,
	policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
})

// Declared here so destroy removes it; otherwise Lambda creates an untagged one outside the stack.
const logs = new aws.cloudwatch.LogGroup('lambda', {
	name: `/aws/lambda/${FUNCTION_NAME}`,
	retentionInDays: 1,
})

const fn = new aws.lambda.Function(
	'health',
	{
		name: FUNCTION_NAME,
		runtime: aws.lambda.Runtime.NodeJS22dX,
		architectures: ['arm64'],
		handler: 'index.handler',
		role: role.arn,
		memorySize: 128,
		timeout: 5,
		code: new pulumi.asset.AssetArchive({
			'index.mjs': new pulumi.asset.StringAsset(HANDLER),
		}),
	},
	{ dependsOn: [logs] },
)

const targetGroup = new aws.lb.TargetGroup('health', {
	name: 'hw31-demo-health',
	targetType: 'lambda',
	// Lambda target groups ship with health checks off, which reports the target as "unavailable".
	healthCheck: {
		enabled: true,
		path: '/health',
		matcher: '200',
		interval: 35,
		timeout: 30,
		healthyThreshold: 2,
		unhealthyThreshold: 2,
	},
})

const invoke = new aws.lambda.Permission('alb-invoke', {
	function: fn.name,
	action: 'lambda:InvokeFunction',
	principal: 'elasticloadbalancing.amazonaws.com',
	sourceArn: targetGroup.arn,
})

new aws.lb.TargetGroupAttachment(
	'health',
	{ targetGroupArn: targetGroup.arn, targetId: fn.arn },
	{ dependsOn: [invoke] },
)

export const alb = new aws.lb.LoadBalancer('alb', {
	name: 'hw31-demo',
	loadBalancerType: 'application',
	internal: false,
	subnets: base.publicSubnetIds,
	securityGroups: [base.albSgId],
})

new aws.lb.Listener('http', {
	loadBalancerArn: alb.arn,
	port: 80,
	protocol: 'HTTP',
	defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.arn }],
})

export const targetGroupArn = targetGroup.arn
