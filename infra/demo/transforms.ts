import * as pulumi from '@pulumi/pulumi'

// Registered before any resource exists: a forgotten deletion protection or
// final snapshot would turn `pulumi destroy` into a bill that outlives it.
pulumi.runtime.registerResourceTransform((args) =>
	args.type === 'aws:rds/instance:Instance'
		? {
				props: {
					...args.props,
					deletionProtection: false,
					skipFinalSnapshot: true,
				},
				opts: args.opts,
			}
		: undefined,
)
